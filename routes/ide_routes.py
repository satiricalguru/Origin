"""IDE integration routes — Workspace explorer, file viewer and writer."""

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Dict, Any, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Hard cap on text file size we will read or write through the IDE. Files
# larger than this are rejected up-front so an editor session can't OOM the
# server or accidentally let an agent write a multi-GB junk file.
_MAX_READ_BYTES = 5 * 1024 * 1024       # 5 MiB
_MAX_WRITE_BYTES = 5 * 1024 * 1024      # 5 MiB

# Persistence file to remember last opened workspace across restarts
_WORKSPACE_PREFS_FILE = Path(os.getcwd()).resolve() / "data" / "ide_workspace.json"

def _load_saved_workspace() -> Path:
    """Load the last saved workspace path from prefs file. Falls back to CWD."""
    try:
        if _WORKSPACE_PREFS_FILE.exists():
            data = json.loads(_WORKSPACE_PREFS_FILE.read_text())
            saved = Path(data.get("workspace", ""))
            if saved.is_dir():
                return saved.resolve()
    except Exception:
        pass
    return Path(os.getcwd()).resolve()

def _save_workspace(path: Path) -> None:
    """Persist workspace path to prefs file."""
    try:
        _WORKSPACE_PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _WORKSPACE_PREFS_FILE.write_text(json.dumps({"workspace": str(path)}))
    except Exception as e:
        logger.warning(f"Could not persist workspace preference: {e}")

# Base workspace path — restored from last saved preference, or CWD on first run
ACTIVE_WORKSPACE = _load_saved_workspace()

def get_active_workspace_path() -> Path:
    """Retrieve the dynamically set active workspace path."""
    return ACTIVE_WORKSPACE

def secure_path(requested_path: str) -> Path:
    """Ensure target path is safe and strictly inside the active workspace root."""
    active_root = get_active_workspace_path()
    if not requested_path:
        return active_root
    
    # Try resolving relative path first, or absolute path
    target = Path(requested_path)
    if not target.is_absolute():
        target = active_root / target
        
    resolved = target.resolve()
    
    # Check that resolved path is inside active_root
    if resolved != active_root and active_root not in resolved.parents:
        raise HTTPException(status_code=403, detail="Access outside workspace directory is forbidden")
        
    return resolved

class FileSaveRequest(BaseModel):
    path: str
    content: str = Field(...)

    @property
    def content_size(self) -> int:
        return len(self.content.encode("utf-8")) if self.content else 0

class FolderCreateRequest(BaseModel):
    path: str

class FileDeleteRequest(BaseModel):
    path: str

class FileRenameRequest(BaseModel):
    path: str
    new_path: str

class WorkspaceUpdateRequest(BaseModel):
    path: str

def select_directory_dialog() -> Optional[str]:
    """Open a native folder dialog to select a workspace directory."""
    import sys
    import subprocess
    
    if sys.platform == "darwin":
        # AppleScript for macOS (bring Finder to front first)
        cmd = [
            "osascript",
            "-e", 'tell application "Finder"',
            "-e", 'activate',
            "-e", 'set theFolder to choose folder with prompt "Select Workspace Folder"',
            "-e", 'POSIX path of theFolder',
            "-e", 'end tell'
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            path = res.stdout.strip()
            if path:
                return path
        except subprocess.CalledProcessError as e:
            # User cancelled or AppleScript failed
            logger.info(f"User cancelled folder dialog or AppleScript failed: {e.stderr}")
            return None
    elif sys.platform == "win32":
        # PowerShell for Windows (using a TopMost form owner to bring dialog to front)
        ps_script = (
            "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null;"
            "$objForm = New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$objForm.Description = 'Select Workspace Folder';"
            "$objForm.ShowNewFolderButton = $true;"
            "$w = New-Object System.Windows.Forms.Form;"
            "$w.TopMost = $true;"
            "$res = $objForm.ShowDialog($w);"
            "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Host $objForm.SelectedPath }"
        )
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
            path = res.stdout.strip()
            if path:
                return path
        except subprocess.CalledProcessError as e:
            logger.info(f"User cancelled folder dialog or PowerShell failed: {e.stderr}")
            return None
    elif sys.platform.startswith("linux"):
        # Zenity for Linux (common on Gnome / Ubuntu)
        if shutil.which("zenity"):
            cmd = ["zenity", "--file-selection", "--directory", "--title=Select Workspace Folder"]
            try:
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
                path = res.stdout.strip()
                if path:
                    return path
            except subprocess.CalledProcessError:
                return None
    return None

def setup_ide_routes() -> APIRouter:
    router = APIRouter(tags=["ide"])

    @router.post("/api/ide/select_folder")
    def select_folder() -> Dict[str, Any]:
        """Open a native folder dialog to select a workspace directory."""
        path = select_directory_dialog()
        if path:
            return {"success": True, "path": path}
        return {"success": False, "cancelled": True}

    @router.get("/api/ide/workspace")
    async def get_workspace_root() -> Dict[str, str]:
        """Get the absolute path of the current active workspace root."""
        return {"root": str(get_active_workspace_path())}

    @router.post("/api/ide/workspace")
    async def set_workspace_root(req: WorkspaceUpdateRequest) -> Dict[str, Any]:
        """Update the active workspace root folder."""
        global ACTIVE_WORKSPACE
        path_str = req.path.strip()
        if not path_str:
            raise HTTPException(status_code=400, detail="Path cannot be empty")

        # Expand ~, resolve symlinks, and reject the obvious "nope" choices
        # before we point ACTIVE_WORKSPACE at something dangerous (e.g. /).
        try:
            expanded = os.path.expanduser(path_str)
            target = Path(expanded).resolve()
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid path: {e}")
        if not target.is_dir():
            raise HTTPException(status_code=400, detail="Path is not a valid directory")

        # Refuse workspace roots that would let the editor walk off the
        # filesystem and start reading /etc or /var. We allow any directory
        # the caller can name EXCEPT a small list of system locations.
        # Per-user temp dirs (e.g. /var/folders/... on macOS, /tmp on Linux)
        # are explicitly exempted because they're how pytest and similar
        # tools create scratch workspaces.
        target_str = str(target)
        forbidden_roots = ("/", "/etc", "/var", "/usr", "/bin", "/sbin",
                           "/System", "/Library", "/private")
        safe_subpath_prefixes = (
            "/var/folders",               # macOS per-user temp dir
            "/private/var/folders",       # resolved symlink form
            "/tmp",                       # Linux/BSD per-user temp dir
            "/private/tmp",               # resolved symlink form on macOS
        )
        for root in forbidden_roots:
            if target_str == root or target_str.startswith(root + os.sep):
                if any(target_str.startswith(p) for p in safe_subpath_prefixes):
                    continue
                raise HTTPException(
                    status_code=400,
                    detail=f"Refusing to open system path '{target_str}' as a workspace",
                )

        ACTIVE_WORKSPACE = target
        _save_workspace(target)
        logger.info(f"Workspace root updated to: {ACTIVE_WORKSPACE}")
        return {"success": True, "root": str(ACTIVE_WORKSPACE)}

    @router.get("/api/ide/files")
    async def list_files(dir_path: str = "") -> List[Dict[str, Any]]:
        """List files and folders in the target directory inside the active workspace."""
        try:
            target = secure_path(dir_path)
            if not target.is_dir():
                raise HTTPException(status_code=400, detail="Target path is not a directory")
                
            active_root = get_active_workspace_path()
            items = []
            # Scan directory entries
            for entry in os.scandir(target):
                # Skip hidden directories like .git or .pytest_cache or venv to keep tree responsive
                if entry.name.startswith(".") and entry.name != ".env":
                    if entry.name in (".git", ".pytest_cache", ".gemini", ".idea", ".vscode"):
                        continue
                if entry.name in ("venv", "__pycache__", "node_modules"):
                    continue
                    
                entry_path = Path(entry.path)
                rel_path = str(entry_path.relative_to(active_root))
                
                size = 0
                if entry.is_file():
                    try:
                        size = entry.stat().st_size
                    except Exception:
                        size = 0
                        
                items.append({
                    "name": entry.name,
                    "path": str(entry_path),
                    "rel_path": rel_path,
                    "is_dir": entry.is_dir(),
                    "size": size
                })
                
            # Sort: directories first, then files alphabetically
            items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
            return items
            
        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE list files error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to list directory contents: {str(e)}")

    @router.get("/api/ide/read_file")
    async def read_file(path: str) -> Dict[str, Any]:
        """Safely read text content of a workspace file."""
        try:
            target = secure_path(path)
            if not target.is_file():
                raise HTTPException(status_code=400, detail="Target path is not a file")

            # Enforce a hard cap so a 4 GB log can't blow up the server.
            try:
                file_size = target.stat().st_size
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to stat file: {str(e)}")
            if file_size > _MAX_READ_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large to edit in the IDE ({file_size} bytes; cap is {_MAX_READ_BYTES} bytes)",
                )

            # Read content with fallback encodings
            try:
                content = target.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                try:
                    content = target.read_text(encoding="latin-1")
                except Exception:
                    raise HTTPException(status_code=400, detail="File is binary or uses unsupported encoding")

            active_root = get_active_workspace_path()
            return {
                "path": str(target),
                "rel_path": str(target.relative_to(active_root)),
                "content": content
            }

        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE read file error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")

    @router.post("/api/ide/write_file")
    async def write_file(req: FileSaveRequest) -> Dict[str, Any]:
        """Safely write/save text content to a workspace file."""
        try:
            target = secure_path(req.path)

            # Reject oversized writes before we touch the disk.
            size = req.content_size
            if size > _MAX_WRITE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Write too large ({size} bytes; cap is {_MAX_WRITE_BYTES} bytes)",
                )

            # Prevent folder creation blockages: create parent folder if it doesn't exist
            target.parent.mkdir(parents=True, exist_ok=True)

            # Write file content
            target.write_text(req.content, encoding="utf-8")

            active_root = get_active_workspace_path()
            return {
                "success": True,
                "path": str(target),
                "rel_path": str(target.relative_to(active_root))
            }

        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE write file error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to write file: {str(e)}")

    @router.post("/api/ide/create_folder")
    async def create_folder(req: FolderCreateRequest) -> Dict[str, Any]:
        """Safely create a new folder/directory inside the workspace."""
        try:
            target = secure_path(req.path)
            target.mkdir(parents=True, exist_ok=True)
            active_root = get_active_workspace_path()
            return {
                "success": True,
                "path": str(target),
                "rel_path": str(target.relative_to(active_root))
            }
        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE create folder error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to create folder: {str(e)}")

    @router.post("/api/ide/delete")
    async def delete_item(req: FileDeleteRequest) -> Dict[str, Any]:
        """Safely delete a file or folder inside the workspace."""
        try:
            target = secure_path(req.path)
            active_root = get_active_workspace_path()
            if target == active_root:
                raise HTTPException(status_code=400, detail="Cannot delete active workspace root")
                
            if target.is_dir():
                shutil.rmtree(target)
            elif target.is_file():
                target.unlink()
            else:
                raise HTTPException(status_code=404, detail="Target path not found")
                
            return {"success": True}
        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE delete error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to delete: {str(e)}")

    @router.post("/api/ide/rename")
    async def rename_item(req: FileRenameRequest) -> Dict[str, Any]:
        """Safely rename or move a file/folder inside the workspace."""
        try:
            target = secure_path(req.path)
            new_target = secure_path(req.new_path)
            
            active_root = get_active_workspace_path()
            if target == active_root:
                raise HTTPException(status_code=400, detail="Cannot rename active workspace root")
                
            if new_target.exists():
                raise HTTPException(status_code=400, detail="Destination path already exists")
                
            # Make sure parent directory of destination exists
            new_target.parent.mkdir(parents=True, exist_ok=True)
            
            # Perform rename
            shutil.move(str(target), str(new_target))
            return {"success": True, "path": str(new_target)}
        except HTTPException as he:
            raise he
        except Exception as e:
            logger.error(f"IDE rename error: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to rename: {str(e)}")
            
    @router.get("/api/ide/git_log")
    async def get_git_log(path: Optional[str] = None) -> List[Dict[str, str]]:
        """Safely fetch recent git commits inside active workspace (optionally for a specific file)."""
        import subprocess
        active_root = get_active_workspace_path()
        try:
            if not (active_root / ".git").is_dir():
                return []
            
            cmd = ["git", "log", "-n", "5", "--oneline", "--format=%h|%s|%an|%ar"]
            if path:
                # Secure path validation
                target = secure_path(path)
                if target.is_file():
                    # Use relative path to make git command safe and robust
                    rel_path = str(target.relative_to(active_root))
                    cmd.extend(["--", rel_path])
                else:
                    return []

            res = subprocess.run(
                cmd,
                cwd=str(active_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True
            )
            commits = []
            for line in res.stdout.strip().split("\n"):
                if not line:
                    continue
                parts = line.split("|")
                if len(parts) >= 4:
                    commits.append({
                        "hash": parts[0],
                        "subject": parts[1],
                        "author": parts[2],
                        "relative_date": parts[3]
                    })
            return commits
        except Exception as e:
            logger.warning(f"Git log failed in IDE: {e}")
            return []

    @router.get("/api/ide/git_branch")
    async def get_git_branch() -> Dict[str, str]:
        """Safely fetch current git branch name inside active workspace."""
        import subprocess
        active_root = get_active_workspace_path()
        try:
            if not (active_root / ".git").is_dir():
                return {"branch": "main"}
            
            res = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=str(active_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True
            )
            branch = res.stdout.strip()
            return {"branch": branch}
        except Exception as e:
            logger.warning(f"Git branch failed in IDE: {e}")
            return {"branch": "main"}

    @router.get("/api/ide/search")
    async def search_workspace(query: str = "") -> List[Dict[str, Any]]:
        """Search for a text query across all files in the active workspace."""
        if not query:
            return []
        
        active_root = get_active_workspace_path()
        results = []
        max_results = 150
        count = 0
        
        # Search walk, ignoring build / runtime artifacts and hidden dirs
        for root, dirs, files in os.walk(active_root):
            # Prune directories in-place to keep search fast
            dirs[:] = [d for d in dirs if d not in (".git", ".pytest_cache", ".gemini", ".idea", ".vscode", "venv", "__pycache__", "node_modules")]
            
            for file in files:
                if file.startswith(".") and file != ".env":
                    continue
                
                file_path = Path(root) / file
                try:
                    # Skip large files or binaries
                    if file_path.stat().st_size > 1024 * 1024:
                        continue
                    
                    content = file_path.read_text(encoding="utf-8", errors="ignore")
                    if not content:
                        continue
                        
                    lines = content.splitlines()
                    for line_idx, line in enumerate(lines):
                        if query.lower() in line.lower():
                            rel_path = str(file_path.relative_to(active_root))
                            results.append({
                                "path": str(file_path),
                                "rel_path": rel_path,
                                "line": line_idx + 1,
                                "content": line.strip()
                            })
                            count += 1
                            if count >= max_results:
                                return results
                except Exception:
                    pass
        return results

    return router
