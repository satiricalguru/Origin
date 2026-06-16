import tempfile
import shutil
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from routes.ide_routes import setup_ide_routes, get_active_workspace_path

@pytest.fixture
def temp_workspace():
    """Create a temporary workspace directory structure."""
    temp_dir = tempfile.mkdtemp()
    workspace_path = Path(temp_dir).resolve()
    
    # Create some dummy files
    (workspace_path / "file1.txt").write_text("Hello World", encoding="utf-8")
    (workspace_path / "folder1").mkdir()
    (workspace_path / "folder1" / "file2.py").write_text("print('test')", encoding="utf-8")
    
    yield workspace_path
    
    # Teardown
    shutil.rmtree(temp_dir)

@pytest.fixture
def client(temp_workspace, monkeypatch):
    """Set up the FastAPI app with setup_ide_routes and set ACTIVE_WORKSPACE."""
    app = FastAPI()
    app.include_router(setup_ide_routes())
    
    # Set the active workspace to the temp workspace
    import routes.ide_routes as ide_routes
    monkeypatch.setattr(ide_routes, "ACTIVE_WORKSPACE", temp_workspace)
    
    return TestClient(app)

class TestIdeRoutes:
    def test_get_workspace(self, client, temp_workspace):
        response = client.get("/api/ide/workspace")
        assert response.status_code == 200
        assert response.json() == {"root": str(temp_workspace)}

    def test_set_workspace(self, client, temp_workspace):
        # Create another directory to switch to
        new_dir = temp_workspace / "new_workspace"
        new_dir.mkdir()
        
        response = client.post("/api/ide/workspace", json={"path": str(new_dir)})
        assert response.status_code == 200
        assert response.json() == {"success": True, "root": str(new_dir)}
        assert get_active_workspace_path() == new_dir

    def test_list_files(self, client):
        response = client.get("/api/ide/files")
        assert response.status_code == 200
        files = response.json()
        
        # Should contain folder1 and file1.txt
        names = [f["name"] for f in files]
        assert "folder1" in names
        assert "file1.txt" in names
        
        # Verify sizes and types
        file1 = next(f for f in files if f["name"] == "file1.txt")
        assert file1["is_dir"] is False
        assert file1["size"] == 11
        
        folder1 = next(f for f in files if f["name"] == "folder1")
        assert folder1["is_dir"] is True

    def test_read_file(self, client):
        response = client.get("/api/ide/read_file?path=file1.txt")
        assert response.status_code == 200
        data = response.json()
        assert data["content"] == "Hello World"
        assert "file1.txt" in data["rel_path"]

    def test_write_file(self, client):
        response = client.post("/api/ide/write_file", json={
            "path": "folder1/new_file.js",
            "content": "console.log('new')"
        })
        assert response.status_code == 200
        assert response.json()["success"] is True
        
        # Read to verify persistence
        read_res = client.get("/api/ide/read_file?path=folder1/new_file.js")
        assert read_res.status_code == 200
        assert read_res.json()["content"] == "console.log('new')"

    def test_create_folder(self, client):
        response = client.post("/api/ide/create_folder", json={
            "path": "folder1/subfolder"
        })
        assert response.status_code == 200
        assert response.json()["success"] is True
        
        # Verify listing
        files_res = client.get("/api/ide/files?dir_path=folder1")
        names = [f["name"] for f in files_res.json()]
        assert "subfolder" in names

    def test_rename_file(self, client, temp_workspace):
        response = client.post("/api/ide/rename", json={
            "path": str(temp_workspace / "file1.txt"),
            "new_path": str(temp_workspace / "folder1" / "renamed.txt")
        })
        assert response.status_code == 200
        assert response.json()["success"] is True
        
        # Verify old path doesn't exist and new one does
        assert not (temp_workspace / "file1.txt").exists()
        assert (temp_workspace / "folder1" / "renamed.txt").exists()

    def test_delete_file(self, client, temp_workspace):
        response = client.post("/api/ide/delete", json={
            "path": str(temp_workspace / "folder1" / "file2.py")
        })
        assert response.status_code == 200
        assert response.json()["success"] is True
        
        # Verify it was deleted
        assert not (temp_workspace / "folder1" / "file2.py").exists()

    def test_security_access_outside_forbidden(self, client, temp_workspace):
        # Trying to traverse outside path
        response = client.get("/api/ide/read_file?path=../some_file.txt")
        assert response.status_code == 403
        assert "forbidden" in response.json()["detail"].lower()

    def test_security_rejects_system_paths(self, client, temp_workspace):
        # System directories must be refused even when they exist
        for forbidden in ("/", "/etc", "/var", "/usr", "/bin", "/sbin"):
            response = client.post("/api/ide/workspace", json={"path": forbidden})
            assert response.status_code == 400, f"expected 400 for {forbidden}, got {response.status_code}"
            assert "system" in response.json()["detail"].lower()

    def test_security_allows_per_user_temp_dirs(self, client, temp_workspace):
        # macOS temp dirs (/var/folders, /private/var/folders) and /tmp are
        # per-user scratch spaces — they must remain open so pytest's
        # tempfile.mkdtemp() and similar tooling keep working. Regression
        # guard: a previous version of set_workspace_root rejected these
        # because their parent (/var or /private) is in the system deny
        # list, which broke the test suite on macOS.
        import tempfile
        for label, factory in (
            ("macOS /var/folders", lambda: tempfile.mkdtemp()),
            ("Linux /tmp", lambda: tempfile.mkdtemp(prefix="t", dir="/tmp")),
        ):
            scratch = factory()
            try:
                response = client.post("/api/ide/workspace", json={"path": scratch})
                assert response.status_code == 200, (
                    f"{label}: expected 200 for {scratch}, got "
                    f"{response.status_code} {response.text}"
                )
            finally:
                import shutil
                shutil.rmtree(scratch, ignore_errors=True)

    def test_git_log(self, client):
        response = client.get("/api/ide/git_log")
        assert response.status_code == 200
        # Since temp_workspace is not a git repo, it should return an empty list
        assert response.json() == []

    def test_git_log_with_path(self, client):
        response = client.get("/api/ide/git_log?path=file1.txt")
        assert response.status_code == 200
        assert response.json() == []

    def test_git_branch(self, client):
        response = client.get("/api/ide/git_branch")
        assert response.status_code == 200
        # Should fallback to main
        assert response.json() == {"branch": "main"}

    def test_search_workspace(self, client):
        # Search for text matching "Hello World" in file1.txt
        res = client.get("/api/ide/search?query=Hello")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 1
        assert "file1.txt" in data[0]["rel_path"]
        assert data[0]["line"] == 1
        assert data[0]["content"] == "Hello World"

        # Search for something that doesn't exist
        res = client.get("/api/ide/search?query=nonexistent")
        assert res.status_code == 200
        assert res.json() == []

    def test_select_folder(self, client, monkeypatch):
        import routes.ide_routes as ide_routes
        monkeypatch.setattr(ide_routes, "select_directory_dialog", lambda: "/dummy/path")
        response = client.post("/api/ide/select_folder")
        assert response.status_code == 200
        assert response.json() == {"success": True, "path": "/dummy/path"}

    def test_select_folder_cancelled(self, client, monkeypatch):
        import routes.ide_routes as ide_routes
        monkeypatch.setattr(ide_routes, "select_directory_dialog", lambda: None)
        response = client.post("/api/ide/select_folder")
        assert response.status_code == 200
        assert response.json() == {"success": False, "cancelled": True}

