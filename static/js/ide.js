/**
 * Workspace IDE Module — Premium integrated VSCode-like development environment.
 */

import * as Modals from './modalManager.js';
import uiModule from './ui.js';
import { providerLogo } from './providers.js';

const API_BASE = window.location.origin;

// Minimal HTML escaper for any user-supplied string we want to drop into
// innerHTML. Centralized so we don't reinvent it in 20 places.
function _escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let _monacoLoaded = false;
let _monacoEditor = null;
let _workspaceRoot = '';
let _openTabs = []; // { path, name, content, isDirty }
let _activeTabIdx = -1;
let _activePanel = 'explorer'; // 'explorer', 'chat', 'notes', 'tasks'
let _terminalHistory = [];
let _ideSessionId = null; // Dedicated IDE copilot session
let _ideRendered = false; // Guard against re-rendering IDE DOM
let _autoSaveEnabled = false;
let _autoSaveTimer = null;

export async function open() {
    const modal = document.getElementById('ide-modal');
    if (!modal) return;

    if (Modals.isMinimized('ide-modal')) {
        Modals.restore('ide-modal');
        return;
    }

    if (!modal.classList.contains('hidden')) {
        return;
    }

    modal.style.display = '';
    Modals.register('ide-modal', {
        railBtnId: 'rail-ide',
        sidebarBtnId: 'tool-ide-btn',
        closeFn: () => _doClose(),
        restoreFn: () => {
            if (_monacoEditor) {
                // Relayout monaco when restoring
                setTimeout(() => _monacoEditor.layout(), 100);
            }
        }
    });

    // Make window draggable and tileable
    _wireDrag(modal);

    modal.classList.remove('hidden');
    
    // Wire up header close and minimize controls
    const minBtn = document.getElementById('minimize-ide-modal');
    if (minBtn) {
        minBtn.onclick = (e) => {
            e.stopPropagation();
            Modals.minimize('ide-modal');
        };
    }
    const closeBtn = document.getElementById('close-ide-modal');
    if (closeBtn) {
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            close();
        };
    }
    
    // Perform initializations
    await _initWorkspace();
    // Only build the IDE DOM once — guard against teardown on every open()
    if (!_ideRendered) {
        _renderIDE();
        _ideRendered = true;
        _printTerminal(`\x1b[1;36mOrigin Integrated Workspace IDE v1.0.0\x1b[0m\nWorkspace Root: ${_workspaceRoot}\nType shell commands in the prompt below to execute.\n\n$ `);
    }
    if (_activeTabIdx >= 0) {
        _updateEditorContent();
    } else {
        _renderWelcomePage();
    }
    _loadMonaco();

    // Attach keybindings
    window.addEventListener('keydown', _ideKeydownHandler);
}

function _doClose() {
    const modal = document.getElementById('ide-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    window.removeEventListener('keydown', _ideKeydownHandler);
}

export function close() {
    if (Modals.isRegistered('ide-modal')) {
        Modals.close('ide-modal');
    } else {
        _doClose();
    }
}

// Drag & drop modal orchestration
let _dragWired = false;
function _wireDrag(modal) {
    if (_dragWired || !modal) return;
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    if (!content || !header) return;
    _dragWired = true;
    if (window.makeWindowDraggable) {
        window.makeWindowDraggable(modal, {
            content, header,
            skipSelector: '.close-btn, .modal-close, .modal-minimize-btn',
            enableDock: true
        });
    }
}

// Initialize Workspace path
async function _initWorkspace() {
    try {
        const res = await fetch(`${API_BASE}/api/ide/workspace`);
        if (res.ok) {
            const data = await res.json();
            _workspaceRoot = data.root;
        }
    } catch (e) {
        _workspaceRoot = 'Workspace';
    }
}

// Lazy Load Monaco Editor
function _loadMonaco() {
    if (_monacoLoaded) return;

    // CSP in core/middleware.py whitelists cdn.jsdelivr.net but not cdnjs.cloudflare.com,
    // so we MUST load from jsdelivr or the script is blocked and the editor silently
    // falls back to a plain <textarea> (losing syntax highlighting, minimap, etc.).
    const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min/vs';

    const loaderScript = document.createElement('script');
    loaderScript.src = `${MONACO_BASE}/loader.js`;
    loaderScript.onload = () => {
        try {
            require.config({ paths: { vs: MONACO_BASE } });
            require(['vs/editor/editor.main'], function () {
                _monacoLoaded = true;
                _initMonacoInstance();
            });
        } catch (e) {
            console.warn('Monaco Editor init failed; falling back to plain text editor.', e);
            _initFallbackTextarea();
        }
    };

    loaderScript.onerror = () => {
        console.warn('Monaco Editor CDN failed to load. Falling back to plain text editor.');
        _initFallbackTextarea();
    };

    document.body.appendChild(loaderScript);
}

// Monaco Instance creation
function _initMonacoInstance() {
    const container = document.getElementById('ide-editor-container');
    if (!container) return;

    // If we already have a live editor AND it's still attached to the DOM,
    // do nothing — the caller wanted to "init" but the editor is fine.
    // This prevents the flicker caused by re-creating the editor every time
    // the welcome page rendered over its container.
    if (_monacoEditor) {
        try {
            const dom = _monacoEditor.getDomNode();
            if (dom && dom.isConnected && container.contains(dom)) {
                return _monacoEditor;
            }
        } catch (_) {}
        // Editor exists but its DOM was wiped (e.g. by _renderWelcomePage) — dispose it.
        try { _monacoEditor.dispose(); } catch (_) {}
        _monacoEditor = null;
    }

    container.innerHTML = ''; // Clear fallback textarea / welcome page

    _monacoEditor = monaco.editor.create(container, {
        value: '',
        language: 'javascript',
        theme: 'vs-dark',
        automaticLayout: true,
        fontFamily: "var(--font-family, 'Fira Code', monospace)",
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: true }
    });

    // Content change event to track modifications
    _monacoEditor.onDidChangeModelContent(() => {
        if (_activeTabIdx >= 0 && _activeTabIdx < _openTabs.length) {
            const tab = _openTabs[_activeTabIdx];
            const currentVal = _monacoEditor.getValue();
            if (currentVal !== tab.content) {
                _markTabDirty(true);
                if (_autoSaveEnabled) {
                    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
                    _autoSaveTimer = setTimeout(() => {
                        saveCurrentFile();
                    }, 1000);
                }
            }
        }
    });

    // Outline + search panel re-render whenever the buffer changes.
    // Attached ONCE here so it never leaks across editor re-creations.
    _monacoEditor.onDidChangeModelContent(() => {
        try { _renderOutline(); } catch (_) {}
    });

    // Wire editor shortcuts
    _monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveCurrentFile();
    });

    // Cursor position tracker — keeps the status bar's "Ln x, Col y"
    // badge in sync with the caret. Cheap; Monaco throttles internally.
    _monacoEditor.onDidChangeCursorPosition((e) => {
        const el = document.getElementById('status-cursor-label');
        if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    // Errors / warnings in the status bar — driven by Monaco's marker
    // model so they update live as the model is parsed / types are
    // resolved. Without this hook the bar is stuck on "0 / 0" forever.
    const _refreshMarkers = () => {
        const model = _monacoEditor.getModel();
        if (!model) return;
        const markers = monaco.editor.getModelMarkers({ resource: model.uri });
        const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error).length;
        const warnings = markers.filter(m => m.severity === monaco.MarkerSeverity.Warning).length;
        const errEl = document.getElementById('status-markers-errors');
        const warnEl = document.getElementById('status-markers-warnings');
        if (errEl) errEl.textContent = `⨂ ${errors}`;
        if (warnEl) warnEl.textContent = `⚠ ${warnings}`;
    };
    _monacoEditor.onDidChangeModelContent(_refreshMarkers);
    // Re-poll on a short timer since not all marker producers fire model
    // change events (some only fire after tokenization finishes).
    setTimeout(_refreshMarkers, 250);
    setTimeout(_refreshMarkers, 1500);

    return _monacoEditor;
}

// Fallback plain Textarea setup (offline-resilient)
function _initFallbackTextarea() {
    const container = document.getElementById('ide-editor-container');
    if (!container) return;
    
    container.innerHTML = `
        <textarea class="ide-fallback-textarea" id="ide-fallback-editor" placeholder="Select a file from the explorer to open and edit..."></textarea>
    `;
    
    const textarea = document.getElementById('ide-fallback-editor');
    textarea.addEventListener('input', () => {
        if (_activeTabIdx >= 0 && _activeTabIdx < _openTabs.length) {
            const tab = _openTabs[_activeTabIdx];
            if (textarea.value !== tab.content) {
                _markTabDirty(true);
                if (_autoSaveEnabled) {
                    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
                    _autoSaveTimer = setTimeout(() => {
                        saveCurrentFile();
                    }, 1000);
                }
            }
        }
    });

    textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveCurrentFile();
        }
    });

    if (_activeTabIdx >= 0) {
        _updateEditorContent();
    }
}

// Render primary IDE view structure
function _renderIDE() {
    const body = document.querySelector('#ide-modal .ide-body');
    if (!body) return;

    body.innerHTML = `
        <div class="ide-container" style="display: flex; flex-direction: column !important; width: 100%; height: 100%; overflow: hidden;">
            <!-- Top Command Menu Bar -->
            <div class="ide-menu-bar" style="display: flex; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--panel); font-size: 11.5px; user-select: none; z-index: 100; flex-shrink: 0;">
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    File
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 180px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-new-text-file" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>New Text File</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌥⌘N</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-new-file" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>New File...</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-new-folder" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>New Folder...</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-new-window" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>New Window</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⇧⌘N</span>
                        </div>
                        <div style="border-top: 1px solid var(--border); margin: 4px 0;"></div>
                        <div class="ide-dropdown-item" id="ide-menu-open-folder" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Open Folder...</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌥⌘O</span>
                        </div>
                        <div class="ide-dropdown-item has-submenu" id="ide-menu-open-recent" style="position: relative; padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Open Recent</span>
                            <span>▶</span>
                            <div class="ide-menu-submenu hidden" id="ide-menu-recent-list" style="position: absolute; left: 100%; top: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 180px; padding: 4px 0;"></div>
                        </div>
                        <div style="border-top: 1px solid var(--border); margin: 4px 0;"></div>
                        <div class="ide-dropdown-item" id="ide-menu-save" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Save</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘S</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-save-as" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Save As...</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⇧⌘S</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-autosave" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Auto Save</span>
                            <span id="ide-menu-autosave-check" style="display: none; color: var(--accent, var(--red));">✓</span>
                        </div>
                        <div style="border-top: 1px solid var(--border); margin: 4px 0;"></div>
                        <div class="ide-dropdown-item" id="ide-menu-close-editor" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Close Editor</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘W</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-close-folder" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Close Folder</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘K F</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-close" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Close Window</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⇧⌘W</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Edit
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 160px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-undo" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Undo</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘Z</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-redo" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Redo</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘Y</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Selection
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 160px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-select-all" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Select All</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘A</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    View
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 180px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-toggle-sidebar" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Toggle Sidebar</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘B</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-toggle-terminal" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Toggle Terminal</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">Ctrl+\`</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Go
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 160px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-go-explorer" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Go to Explorer</span>
                        </div>
                        <div class="ide-dropdown-item" id="ide-menu-go-search" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Go to Search</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⇧⌘F</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Run
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 160px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-run-active" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Run Active File</span>
                            <span style="opacity: 0.4; font-size: 9.5px;">⌘R</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Terminal
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 180px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-clear-terminal" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>Clear Terminal</span>
                        </div>
                    </div>
                </div>
                <div class="ide-menu-item" style="position: relative; padding: 4px 8px; border-radius: 4px; cursor: pointer; color: var(--fg); opacity: 0.8;">
                    Help
                    <div class="ide-menu-dropdown hidden" style="position: absolute; top: 100%; left: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 1000; min-width: 160px; padding: 4px 0; margin-top: 2px;">
                        <div class="ide-dropdown-item" id="ide-menu-about" style="padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                            <span>About Origin IDE</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="ide-container-inner" style="display: flex; flex-direction: row; flex: 1; min-height: 0; width: 100%;">
                <!-- 1. Left Nav strip (Activity Bar) -->
                <div class="ide-nav-bar">
                    <button class="ide-nav-item ${_activePanel === 'explorer' ? 'active' : ''}" data-panel="explorer" title="Explorer">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    </button>
                    <button class="ide-nav-item ${_activePanel === 'search' ? 'active' : ''}" data-panel="search" title="Search Workspace">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </button>
                    <button class="ide-nav-item ${_activePanel === 'chat' ? 'active' : ''}" data-panel="chat" title="Origin Chat">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </button>
                    <button class="ide-nav-item ${_activePanel === 'notes' ? 'active' : ''}" data-panel="notes" title="Notes">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5"/><path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z"/></svg>
                    </button>
                    <button class="ide-nav-item ${_activePanel === 'tasks' ? 'active' : ''}" data-panel="tasks" title="Scheduler Tasks">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></svg>
                    </button>

                    <!-- Bottom Profile and Settings Activity Buttons -->
                    <div style="margin-top: auto; display: flex; flex-direction: column; gap: 8px; width: 100%; align-items: center; padding-bottom: 8px;">
                        <button class="ide-nav-item" id="ide-user-profile-btn" title="Profile" style="opacity: 0.6; display: flex; align-items: center; justify-content: center;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </button>
                        <button class="ide-nav-item" id="ide-settings-btn" title="Settings" style="opacity: 0.6; display: flex; align-items: center; justify-content: center;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.4.4.62.94.6 1.51V11a2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                        </button>
                    </div>
                </div>

                <!-- 2. Left Collapsible sidebar panel -->
                <div class="ide-side-panel" id="ide-side-panel">
                    <div class="ide-panel-header" style="display:flex; justify-content:space-between; align-items:center;">
                        <span id="ide-panel-title">Explorer</span>
                        <div id="ide-panel-actions" style="display:flex; align-items:center; gap:6px;"></div>
                        <button id="ide-panel-close-btn" style="background:none;border:none;color:var(--fg);cursor:pointer;font-size:10px;opacity:0.6;">◀</button>
                    </div>
                    <div class="ide-panel-content" id="ide-panel-content" style="padding:0;">
                        <!-- Dynamic view content -->
                    </div>
                </div>

                <!-- 3. Right workspace area (Editor + Terminal) -->
                <div class="ide-main-area">
                    <!-- Editor Wrapper -->
                    <div class="ide-editor-wrapper">
                        <!-- Tab Strip -->
                        <div class="ide-tab-strip" id="ide-tab-strip"></div>
                        
                        <!-- Editor Toolbar (Save & Run actions) -->
                        <div class="ide-editor-toolbar" id="ide-editor-toolbar" style="display:none;">
                            <button class="ide-toolbar-btn primary" id="ide-save-btn">Save</button>
                            <button class="ide-toolbar-btn" id="ide-run-btn">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;"><path d="M8 5v14l11-7z"/></svg> Run
                            </button>
                        </div>

                        <!-- Editor container -->
                        <div class="ide-editor-container" id="ide-editor-container">
                            <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg);opacity:0.5;font-size:12px;">
                                Select a file from the explorer to open and edit...
                            </div>
                        </div>
                    </div>

                    <!-- 4. Terminal Panel -->
                    <div class="ide-bottom-panel" id="ide-bottom-panel">
                        <div class="ide-bottom-tabs">
                            <span class="ide-bottom-tab">Terminal</span>
                            <button id="ide-terminal-toggle" style="background:none;border:none;color:var(--fg);cursor:pointer;font-size:10px;opacity:0.6;">▼</button>
                        </div>
                        <div class="ide-terminal-body" id="ide-terminal-body">
                            <div class="ide-terminal-output" id="ide-terminal-output"></div>
                            <div class="ide-terminal-input-row">
                                <span class="ide-terminal-prompt">origin &gt; </span>
                                <input type="text" class="ide-terminal-input" id="ide-terminal-input" autocomplete="off" autofocus />
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right Sidebar Panel (Copilot Chat) -->
                <div class="ide-right-sidebar" id="ide-right-sidebar">
                    <div class="ide-right-tabs">
                        <span class="ide-right-tab active" data-tab="chat">Chat</span>
                        <span class="ide-right-tab" data-tab="codex">Codex</span>
                    </div>
                    <div class="ide-right-chat-container">
                        <div class="ide-right-chat-messages" id="ide-right-chat-messages">
                            <div class="ide-right-chat-msg assistant">
                                Hello! I am your Origin AI Copilot. Ask me anything about this project or type instructions to build, refactor, or explain code. I'll stream responses in real-time.
                            </div>
                        </div>
                        <div class="ide-right-chat-input-area">
                            <div class="ide-right-chat-input-wrapper">
                                <textarea class="ide-right-chat-textarea" id="ide-right-chat-textarea" placeholder="Describe what to build or ask about the code..."></textarea>
                                <div class="ide-right-chat-controls">
                                    <div class="ide-chat-ctrl-left">
                                        <button class="ide-chat-ctrl-btn" title="Insert current file context" id="ide-ctx-inject-btn">📎</button>
                                        <button class="ide-chat-ctrl-btn" title="Code snippet">&lt;/&gt;</button>
                                    </div>
                                    <button class="ide-chat-ctrl-send" id="ide-right-chat-send-btn">
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                                    </button>
                                </div>
                            </div>
                            <div class="ide-right-chat-badges">
                                <div class="model-picker-wrap" id="ide-model-picker-wrap" style="position: relative;">
                                    <div class="ide-chat-badge" id="ide-chat-badge-model" tabindex="0" title="Change Copilot model" style="cursor: pointer; user-select: none;">
                                        <span class="ide-chat-badge-dot"></span>
                                        <span id="ide-chat-active-model">Origin AI</span>
                                    </div>
                                    <div class="model-picker-menu hidden" id="ide-model-picker-menu" style="position: absolute; bottom: calc(100% + 8px); left: 0; right: auto; width: 320px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; z-index: 1000; box-shadow: 0 -4px 16px rgba(0,0,0,0.4); max-height: 250px; overflow: hidden; margin-top: 0;">
                                        <div class="model-picker-search-row" style="padding: 6px; border-bottom: 1px solid var(--border); display: flex; gap: 6px; margin-bottom: 0; align-items: center;">
                                            <input type="text" id="ide-model-picker-search" placeholder="Search models..." autocomplete="off" style="flex: 1; box-sizing: border-box; background: var(--bg); border: 1px solid var(--border); color: var(--fg); padding: 4px 8px; font-size: 11px; border-radius: 3px; outline: none;" />
                                            <button type="button" id="ide-model-picker-add-btn" title="Add / Manage models..." style="background: none; border: 1px solid var(--border); border-radius: 3px; color: #007acc; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; padding: 0; flex-shrink: 0;">+</button>
                                        </div>
                                        <div class="model-picker-list" id="ide-model-picker-list" style="overflow-y: auto; flex: 1; font-size: 11.5px; padding: 4px; display: flex; flex-direction: column; gap: 2px;"></div>
                                    </div>
                                </div>
                                <div class="ide-chat-badge">
                                    <span>💬</span>
                                    <span>Streaming</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Status Bar -->
            <div class="ide-status-bar">
                <div class="ide-status-left">
                    <div class="ide-status-item" id="status-git-branch">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px;"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                        <span id="status-git-branch-name">main</span>
                    </div>
                    <div class="ide-status-item" id="status-markers" title="Errors / Warnings">
                        <span id="status-markers-errors" style="color:#ffffff;">⨂ 0</span>
                        <span id="status-markers-warnings" style="color:#ffffff; margin-left:4px;">⚠ 0</span>
                    </div>
                </div>
                <div class="ide-status-right">
                    <div class="ide-status-item" id="status-indent" title="Click to toggle indent (Tab size: 4)">
                        <span id="status-indent-label">Spaces: 4</span>
                    </div>
                    <div class="ide-status-item">
                        <span>UTF-8</span>
                    </div>
                    <div class="ide-status-item">
                        <span id="status-language">Plain Text</span>
                    </div>
                    <div class="ide-status-item" id="status-cursor" title="Line / Column">
                        <span id="status-cursor-label">Ln 1, Col 1</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Wire activity tab clicks
    body.querySelectorAll('.ide-nav-bar .ide-nav-item').forEach(item => {
        if (item.dataset.panel) {
            item.addEventListener('click', () => {
                const panel = item.dataset.panel;
                _switchPanel(panel);
            });
        }
    });

    // Sidebar panel toggle collapse
    document.getElementById('ide-panel-close-btn').addEventListener('click', () => {
        const sidePanel = document.getElementById('ide-side-panel');
        sidePanel.classList.toggle('collapsed');
        setTimeout(() => {
            if (_monacoEditor) _monacoEditor.layout();
        }, 300);
    });

    // Bottom terminal toggle collapse
    document.getElementById('ide-terminal-toggle').addEventListener('click', () => {
        const bottomPanel = document.getElementById('ide-bottom-panel');
        bottomPanel.classList.toggle('collapsed');
        const toggler = document.getElementById('ide-terminal-toggle');
        toggler.textContent = bottomPanel.classList.contains('collapsed') ? '▲' : '▼';
        
        setTimeout(() => {
            if (_monacoEditor) _monacoEditor.layout();
        }, 300);
    });

    // Wire Save / Run button triggers
    document.getElementById('ide-save-btn').addEventListener('click', saveCurrentFile);
    document.getElementById('ide-run-btn').addEventListener('click', runCurrentFile);

    // Wire Terminal command submissions
    const termInput = document.getElementById('ide-terminal-input');
    termInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const cmd = termInput.value.trim();
            if (cmd) {
                _executeTerminalCommand(cmd);
                termInput.value = '';
            }
        }
    });

    // Wire right Copilot chat panel triggers
    const copilotSend = document.getElementById('ide-right-chat-send-btn');
    if (copilotSend) {
        copilotSend.onclick = (e) => {
            e.stopPropagation();
            _sendCopilotMessage();
        };
    }
    const copilotText = document.getElementById('ide-right-chat-textarea');
    if (copilotText) {
        copilotText.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                _sendCopilotMessage();
            }
        };
    }

    // Wire context inject button — inserts current file content into copilot textarea
    const ctxBtn = document.getElementById('ide-ctx-inject-btn');
    if (ctxBtn) {
        ctxBtn.onclick = (e) => {
            e.stopPropagation();
            if (_activeTabIdx >= 0 && _openTabs[_activeTabIdx]) {
                const tab = _openTabs[_activeTabIdx];
                let content = '';
                if (_monacoLoaded && _monacoEditor) {
                    content = _monacoEditor.getValue();
                } else {
                    const ta = document.getElementById('ide-fallback-editor');
                    if (ta) content = ta.value;
                }
                const textarea = document.getElementById('ide-right-chat-textarea');
                if (textarea) {
                    const prefix = `[Context from ${tab.name}]\n\`\`\`\n${content.substring(0, 3000)}\n\`\`\`\n\n`;
                    textarea.value = prefix + textarea.value;
                    textarea.focus();
                }
            } else {
                uiModule.showToast('No file open to inject as context.');
            }
        };
    }

    // Initialize top menu bar and custom model picker dropdown
    _initIdeMenuBar();
    _initIdeModelPicker();

    // Wire profiles and settings buttons
    const userBtn = document.getElementById('ide-user-profile-btn');
    if (userBtn) {
        userBtn.onclick = () => {
            uiModule.showToast('Profile: Admin developer logged in.');
        };
    }
    const settingsBtn = document.getElementById('ide-settings-btn');
    if (settingsBtn) {
        settingsBtn.onclick = () => {
            const rightSidebar = document.getElementById('ide-right-sidebar');
            if (rightSidebar) {
                rightSidebar.classList.toggle('collapsed');
                setTimeout(() => {
                    if (_monacoEditor) _monacoEditor.layout();
                }, 300);
            }
        };
    }

    // Load dynamic Git details in status bar
    _loadGitBranch();

    // Wire indent status-bar click — toggles "Spaces: N" between 2 / 4 / Tab.
    const indentEl = document.getElementById('status-indent');
    if (indentEl) {
        indentEl.onclick = (e) => {
            e.stopPropagation();
            if (!_monacoEditor) return;
            const model = _monacoEditor.getModel();
            if (!model) return;
            const opts = _monacoEditor.getOption(monaco.editor.EditorOptions.indentSize)
                ?? model.getOptions().indentSize
                ?? 4;
            const current = (typeof opts === 'number') ? opts : 4;
            // Cycle 2 → 4 → Tab(4) → 2 …
            const next = current === 2 ? 4 : (current === 4 ? 'tab' : 2);
            if (next === 'tab') {
                model.updateOptions({ insertSpaces: false, indentSize: 4, tabSize: 4 });
            } else {
                model.updateOptions({ insertSpaces: true, indentSize: next, tabSize: next });
            }
            _updateIndentLabel(next);
        };
    }
    _updateIndentLabel(4);

    // Switch to initial active panel
    _switchPanel(_activePanel);
}

function _updateIndentLabel(value) {
    const el = document.getElementById('status-indent-label');
    if (!el) return;
    if (value === 'tab') {
        el.textContent = 'Tab Size: 4';
    } else {
        el.textContent = `Spaces: ${value}`;
    }
}

// Switch Side Subpanel Tab
function _switchPanel(panelName) {
    _activePanel = panelName;
    
    // Toggle navigation button highlight
    const modal = document.getElementById('ide-modal');
    modal.querySelectorAll('.ide-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.panel === panelName);
    });

    // Update Side Panel Title
    const titleEl = document.getElementById('ide-panel-title');
    titleEl.textContent = panelName.charAt(0).toUpperCase() + panelName.slice(1);

    // Render Tab Panel Content
    const sidePanel = document.getElementById('ide-side-panel');
    sidePanel.classList.remove('collapsed');

    const contentEl = document.getElementById('ide-panel-content');
    contentEl.innerHTML = '';

    // Render panel actions
    const actionsEl = document.getElementById('ide-panel-actions');
    if (actionsEl) {
        actionsEl.innerHTML = '';
        if (panelName === 'explorer') {
            actionsEl.innerHTML = `
                <button class="ide-explorer-action-btn" id="ide-action-new-file" title="New File...">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                </button>
                <button class="ide-explorer-action-btn" id="ide-action-new-folder" title="New Folder...">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="17" x2="12" y2="11"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                </button>
                <button class="ide-explorer-action-btn" id="ide-action-refresh" title="Refresh Explorer">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                </button>
                <button class="ide-explorer-action-btn" id="ide-action-collapse" title="Collapse All Folders">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                </button>
            `;
            
            document.getElementById('ide-action-new-file').onclick = (e) => { e.stopPropagation(); _createNewFile(); };
            document.getElementById('ide-action-new-folder').onclick = (e) => { e.stopPropagation(); _createNewFolder(); };
            document.getElementById('ide-action-refresh').onclick = (e) => { e.stopPropagation(); refreshExplorer(); };
            document.getElementById('ide-action-collapse').onclick = (e) => { e.stopPropagation(); _expandedDirs.clear(); refreshExplorer(); };
        }
    }

    if (panelName === 'explorer') {
        contentEl.innerHTML = `
            <div class="ide-sidebar-section" id="ide-section-files">
                <div class="ide-sidebar-section-header">
                    <span>Workspace Folder</span>
                    <span class="section-arrow">▼</span>
                </div>
                <div class="ide-sidebar-section-content" id="ide-section-files-content" style="padding:0;"></div>
            </div>
            <div class="ide-sidebar-section" id="ide-section-outline">
                <div class="ide-sidebar-section-header">
                    <span>Outline</span>
                    <span class="section-arrow">▼</span>
                </div>
                <div class="ide-sidebar-section-content" id="ide-section-outline-content" style="padding:0;">
                    <div style="font-size:11px; opacity:0.5; padding:8px;">No outline symbols available.</div>
                </div>
            </div>
            <div class="ide-sidebar-section" id="ide-section-timeline">
                <div class="ide-sidebar-section-header">
                    <span>Timeline</span>
                    <span class="section-arrow">▼</span>
                </div>
                <div class="ide-sidebar-section-content" id="ide-section-timeline-content" style="padding:0;">
                    <div style="font-size:11px; opacity:0.5; padding:8px;">Loading timeline...</div>
                </div>
            </div>
        `;
        
        // Wire collapsible header clicks
        contentEl.querySelectorAll('.ide-sidebar-section-header').forEach(header => {
            header.onclick = (e) => {
                const section = header.parentElement;
                section.classList.toggle('collapsed');
                const arrow = header.querySelector('.section-arrow');
                if (arrow) {
                    arrow.textContent = section.classList.contains('collapsed') ? '▶' : '▼';
                }
            };
        });

        _renderExplorer(document.getElementById('ide-section-files-content'));
        _renderOutline();
        _renderTimeline();
    } else if (panelName === 'search') {
        _renderWorkspaceSearch(contentEl);
    } else if (panelName === 'chat') {
        _renderIntegratedChat(contentEl);
    } else if (panelName === 'notes') {
        _renderIntegratedNotes(contentEl);
    } else if (panelName === 'tasks') {
        _renderIntegratedTasks(contentEl);
    }
}

async function refreshExplorer() {
    const filesContentEl = document.getElementById('ide-section-files-content');
    if (filesContentEl) {
        await _renderExplorer(filesContentEl);
    } else {
        const contentEl = document.getElementById('ide-panel-content');
        if (contentEl && _activePanel === 'explorer') {
            _switchPanel('explorer');
        }
    }
}

// ──────────────────────────────────────────
// Tab 1: File Explorer Tree Implementation
// ──────────────────────────────────────────
let _expandedDirs = new Set(); // Stores expanded absolute paths

async function _renderExplorer(container) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:8px;">Loading workspace root...</div>';
    
    try {
        const rootFiles = await _fetchDirFiles('');
        container.innerHTML = '';
        
        // Prepend workspace switcher input
        const switcher = document.createElement('div');
        switcher.className = 'ide-workspace-switcher';
        switcher.innerHTML = `
            <label>Workspace Folder</label>
            <div class="ide-workspace-input-row">
                <input type="text" class="ide-workspace-input" id="ide-workspace-path-input" value="${_workspaceRoot}" placeholder="Enter absolute directory path..." />
                <button class="ide-workspace-btn" id="ide-workspace-open-btn">Open</button>
            </div>
        `;
        container.appendChild(switcher);
        
        // Wire switcher open button
        const openBtn = switcher.querySelector('#ide-workspace-open-btn');
        const pathInput = switcher.querySelector('#ide-workspace-path-input');
        
        const triggerOpenFolder = async () => {
            const newPath = pathInput.value.trim();
            if (!newPath) return;
            
            try {
                const res = await fetch(`${API_BASE}/api/ide/workspace`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newPath })
                });
                
                if (res.ok) {
                    const data = await res.json();
                    _workspaceRoot = data.root;
                    uiModule.showToast('Workspace loaded successfully');
                    
                    // Re-render
                    _renderExplorer(container);
                } else {
                    const err = await res.json();
                    uiModule.showError(`Failed to load folder: ${err.detail || 'Folder does not exist'}`);
                }
            } catch (e) {
                uiModule.showError(`Error: ${e.message}`);
            }
        };
        
        openBtn.onclick = (e) => { e.stopPropagation(); triggerOpenFolder(); };
        pathInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.stopPropagation();
                triggerOpenFolder();
            }
        };

        // Add root node
        const rootNode = document.createElement('div');
        rootNode.style.fontWeight = 'bold';
        rootNode.style.margin = '10px 0 6px 0';
        rootNode.style.fontSize = '12px';
        // Build the root label with DOM APIs so an attacker-controlled
        // workspace path can't inject HTML here.
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;';
        const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ico.setAttribute('width', '14');
        ico.setAttribute('height', '14');
        ico.setAttribute('viewBox', '0 0 24 24');
        ico.setAttribute('fill', 'none');
        ico.setAttribute('stroke', '#007acc');
        ico.setAttribute('stroke-width', '2');
        ico.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/>';
        const label = document.createElement('span');
        // Use the basename of the workspace path; fall back to the full
        // path when the path is just "/" (which would otherwise yield "")
        // and finally to a generic "Workspace" when no path is set.
        const wsName = (_workspaceRoot || '').split('/').filter(Boolean).pop() || _workspaceRoot || 'Workspace';
        label.textContent = wsName;
        label.title = _workspaceRoot || '';
        row.appendChild(ico);
        row.appendChild(label);
        rootNode.appendChild(row);
        container.appendChild(rootNode);

        const treeContainer = document.createElement('div');
        treeContainer.className = 'ide-file-list';
        container.appendChild(treeContainer);

        _buildFileTreeNodes(rootFiles, treeContainer, 0);

    } catch (e) {
        container.innerHTML = `<div style="font-size:11px;color:var(--color-error);padding:8px;">Error loading workspace: ${_escHtml(e.message)}</div>`;
    }
}

async function _fetchDirFiles(relPath) {
    const res = await fetch(`${API_BASE}/api/ide/files?dir_path=${encodeURIComponent(relPath)}`);
    if (!res.ok) {
        throw new Error('Failed to fetch file listing');
    }
    return await res.json();
}

function _buildFileTreeNodes(files, parentContainer, indentLevel) {
    files.forEach(file => {
        const row = document.createElement('div');
        row.className = `ide-tree-node ${file.is_dir ? 'folder-node' : 'file-node'}`;
        if (_openTabs[_activeTabIdx] && _openTabs[_activeTabIdx].path === file.path) {
            row.classList.add('active');
        }

        // Indent guides
        for (let i = 0; i < indentLevel; i++) {
            const ind = document.createElement('span');
            ind.className = 'ide-tree-indent';
            row.appendChild(ind);
        }

        // Arrow / expand chevron
        const arrow = document.createElement('span');
        arrow.className = 'ide-tree-arrow' + (file.is_dir && _expandedDirs.has(file.path) ? ' expanded' : '');
        arrow.textContent = '▶';
        if (!file.is_dir) arrow.style.visibility = 'hidden';
        row.appendChild(arrow);

        // Icon (returned as innerHTML SVG string from _getFileIcon)
        const iconWrap = document.createElement('span');
        iconWrap.className = 'ide-tree-icon';
        iconWrap.innerHTML = _getFileIcon(file.name, file.is_dir, _expandedDirs.has(file.path));
        row.appendChild(iconWrap);

        // Filename (textContent so a hostile filename can't inject markup)
        const nameEl = document.createElement('span');
        nameEl.className = 'grow';
        nameEl.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameEl.textContent = file.name;
        nameEl.title = file.path;
        row.appendChild(nameEl);

        parentContainer.appendChild(row);

        // Subfolders container
        let subContainer = null;
        const isExpanded = _expandedDirs.has(file.path);
        if (file.is_dir && isExpanded) {
            subContainer = document.createElement('div');
            parentContainer.appendChild(subContainer);
            _loadSubfolderFiles(file.rel_path, subContainer, indentLevel + 1);
        }

        // Handle Clicks
        row.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (file.is_dir) {
                if (_expandedDirs.has(file.path)) {
                    _expandedDirs.delete(file.path);
                    const arrowEl = row.querySelector('.ide-tree-arrow');
                    if (arrowEl) arrowEl.classList.remove('expanded');
                    if (subContainer) subContainer.remove();
                } else {
                    _expandedDirs.add(file.path);
                    const arrowEl = row.querySelector('.ide-tree-arrow');
                    if (arrowEl) arrowEl.classList.add('expanded');
                    subContainer = document.createElement('div');
                    row.after(subContainer);
                    _loadSubfolderFiles(file.rel_path, subContainer, indentLevel + 1);
                }
            } else {
                // Remove active classes
                document.querySelectorAll('.ide-tree-node.file-node').forEach(node => node.classList.remove('active'));
                row.classList.add('active');
                
                await openFile(file.path, file.name);
            }
        });

        // Handle right click Context Menu
        row.addEventListener('contextmenu', (e) => {
            _showContextMenu(e, file);
        });
    });
}

async function _loadSubfolderFiles(relPath, subContainer, indentLevel) {
    subContainer.innerHTML = '<div style="font-size:10px;opacity:0.4;padding:4px 16px;">Loading...</div>';
    try {
        const subFiles = await _fetchDirFiles(relPath);
        subContainer.innerHTML = '';
        _buildFileTreeNodes(subFiles, subContainer, indentLevel);
    } catch (e) {
        subContainer.innerHTML = `<div style="font-size:10px;color:var(--color-error);padding:4px 16px;">Error</div>`;
    }
}

// ──────────────────────────────────────────
// Core File Reading, Tab & Editor Operations
// ──────────────────────────────────────────
export async function openFile(filePath, fileName) {
    try {
        // Check if file is already open
        const existingIdx = _openTabs.findIndex(t => t.path === filePath);
        if (existingIdx >= 0) {
            _activeTabIdx = existingIdx;
            _updateEditorContent();
            _renderTabStrip();
            return;
        }

        // Fetch file content
        const res = await fetch(`${API_BASE}/api/ide/read_file?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) {
            throw new Error('Failed to read file content');
        }
        
        const data = await res.json();
        
        _openTabs.push({
            path: filePath,
            name: fileName,
            content: data.content,
            isDirty: false
        });
        
        _activeTabIdx = _openTabs.length - 1;
        _updateEditorContent();
        _renderTabStrip();

    } catch (e) {
        uiModule.showError(`Error opening file: ${e.message}`);
    }
}

function _updateEditorContent() {
    if (_activeTabIdx < 0 || _activeTabIdx >= _openTabs.length) {
        return;
    }

    const tab = _openTabs[_activeTabIdx];

    // Reveal toolbar
    document.getElementById('ide-editor-toolbar').style.display = 'flex';

    const container = document.getElementById('ide-editor-container');
    if (container && (container.querySelector('.vscode-welcome') || container.innerHTML.trim() === '' || !_monacoEditor)) {
        // We need to re-initialize editor!
        if (_monacoLoaded) {
            _initMonacoInstance();
        } else {
            _initFallbackTextarea();
        }
    }

    if (_monacoLoaded && _monacoEditor) {
        const ext = tab.name.split('.').pop().toLowerCase();
        let lang = 'javascript';
        let langLabel = 'JavaScript';
        if (ext === 'py') { lang = 'python'; langLabel = 'Python'; }
        else if (ext === 'html' || ext === 'htm') { lang = 'html'; langLabel = 'HTML'; }
        else if (ext === 'css') { lang = 'css'; langLabel = 'CSS'; }
        else if (ext === 'json') { lang = 'json'; langLabel = 'JSON'; }
        else if (ext === 'sh' || ext === 'bash') { lang = 'shell'; langLabel = 'Shell Script'; }
        else if (ext === 'md' || ext === 'markdown') { lang = 'markdown'; langLabel = 'Markdown'; }
        else if (ext === 'ts') { lang = 'typescript'; langLabel = 'TypeScript'; }
        else if (ext === 'yml' || ext === 'yaml') { lang = 'yaml'; langLabel = 'YAML'; }
        else if (ext === 'xml') { lang = 'xml'; langLabel = 'XML'; }
        else if (ext === 'sql') { lang = 'sql'; langLabel = 'SQL'; }
        else if (ext === 'rs') { lang = 'rust'; langLabel = 'Rust'; }
        else if (ext === 'go') { lang = 'go'; langLabel = 'Go'; }
        else if (ext === 'java') { lang = 'java'; langLabel = 'Java'; }
        else if (['txt', 'log', 'env', 'cfg', 'conf', 'ini'].includes(ext)) { lang = 'plaintext'; langLabel = 'Plain Text'; }

        // Update status bar language indicator
        const statusLang = document.getElementById('status-language');
        if (statusLang) statusLang.textContent = langLabel;

        const model = _monacoEditor.getModel();
        monaco.editor.setModelLanguage(model, lang);
        _monacoEditor.setValue(tab.content);

        // Trigger outline and timeline refresh on tab open.
        // (The persistent model-content listener is attached once in
        // _initMonacoInstance so the outline updates as the user types.)
        _renderOutline();
        _renderTimeline(tab.path);
    } else {
        const textarea = document.getElementById('ide-fallback-editor');
        if (textarea) {
            textarea.value = tab.content;
            _renderOutline();
            _renderTimeline(tab.path);
        }
    }
}

function _renderTabStrip() {
    const strip = document.getElementById('ide-tab-strip');
    if (!strip) return;

    strip.innerHTML = '';
    _openTabs.forEach((tab, idx) => {
        const tabEl = document.createElement('div');
        tabEl.className = `ide-tab ${idx === _activeTabIdx ? 'active' : ''}`;
        // Build with DOM APIs so a filename containing < or & can't inject
        // HTML into the tab strip (an XSS vector when an agent / file
        // service produces a file with a hostile name).
        const labelSpan = document.createElement('span');
        labelSpan.textContent = tab.name;
        if (tab.isDirty) {
            const dot = document.createElement('span');
            dot.style.color = 'var(--accent)';
            dot.textContent = ' ●';
            labelSpan.appendChild(dot);
        }
        const closeSpan = document.createElement('span');
        closeSpan.className = 'ide-tab-close';
        closeSpan.dataset.idx = String(idx);
        closeSpan.textContent = '×';
        tabEl.appendChild(labelSpan);
        tabEl.appendChild(closeSpan);

        tabEl.addEventListener('click', () => {
            _activeTabIdx = idx;
            _updateEditorContent();
            _renderTabStrip();
        });

        tabEl.querySelector('.ide-tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            _closeTab(idx);
        });

        strip.appendChild(tabEl);
    });
}

function _closeTab(idx) {
    const tab = _openTabs[idx];
    if (tab.isDirty) {
        if (!confirm(`Save changes to "${tab.name}" before closing?`)) {
            // Drop unsaved changes
        } else {
            saveCurrentFile();
        }
    }

    _openTabs.splice(idx, 1);
    
    if (_activeTabIdx === idx) {
        _activeTabIdx = _openTabs.length - 1;
    } else if (_activeTabIdx > idx) {
        _activeTabIdx--;
    }

    if (_openTabs.length === 0) {
        _activeTabIdx = -1;
        // Properly dispose Monaco to prevent memory leaks
        if (_monacoEditor) {
            try { _monacoEditor.dispose(); } catch(_) {}
            _monacoEditor = null;
        }
        _renderWelcomePage();
        _renderTimeline(null);
    } else {
        _updateEditorContent();
    }
    _renderTabStrip();
}

function _markTabDirty(isDirty) {
    if (_activeTabIdx >= 0 && _activeTabIdx < _openTabs.length) {
        const tab = _openTabs[_activeTabIdx];
        if (tab.isDirty !== isDirty) {
            tab.isDirty = isDirty;
            _renderTabStrip();
        }
    }
}
function _createNewTextFile() {
    const untitledId = `untitled-${Date.now()}`;
    _openTabs.push({
        path: untitledId,
        name: `Untitled-${_openTabs.filter(t => t.name.startsWith('Untitled-')).length + 1}`,
        content: '',
        isDirty: true
    });
    _activeTabIdx = _openTabs.length - 1;
    _updateEditorContent();
    _renderTabStrip();
}

function _createNewWindow() {
    window.open(window.location.href, '_blank');
}

function _openFolderPrompt() {
    const current = _workspaceRoot || '';
    const path = prompt("Enter the absolute path of the folder to open:", current);
    if (path && path.trim()) {
        _changeWorkspaceFolder(path.trim());
    }
}

async function _changeWorkspaceFolder(newPath) {
    if (!newPath) return;
    try {
        const res = await fetch(`${API_BASE}/api/ide/workspace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: newPath })
        });
        if (res.ok) {
            const data = await res.json();
            _workspaceRoot = data.root;
            uiModule.showToast('Workspace loaded successfully');
            
            // Save to recents in localStorage
            let recents = [];
            try {
                recents = JSON.parse(localStorage.getItem('ide-recent-workspaces')) || [];
            } catch(e) {}
            // Add and deduplicate
            recents = [data.root, ...recents.filter(p => p !== data.root)].slice(0, 5);
            localStorage.setItem('ide-recent-workspaces', JSON.stringify(recents));

            // Re-render Explorer panel
            const filesContentEl = document.getElementById('ide-section-files-content');
            if (filesContentEl) {
                _renderExplorer(filesContentEl);
            } else {
                refreshExplorer();
            }
            _renderTimeline(null);
            _renderOutline();
        } else {
            const err = await res.json();
            uiModule.showError(`Failed to load folder: ${err.detail || 'Folder does not exist'}`);
        }
    } catch (e) {
        uiModule.showError(`Error: ${e.message}`);
    }
}

async function _saveFileAs() {
    if (_activeTabIdx < 0 || !_openTabs[_activeTabIdx]) {
        uiModule.showToast('No active file to save.');
        return;
    }
    const tab = _openTabs[_activeTabIdx];
    const newPath = prompt("Enter new filename or path relative to workspace:", tab.name);
    if (!newPath || !newPath.trim()) return;

    try {
        const res = await fetch(`${API_BASE}/api/ide/write_file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: newPath.trim(),
                content: _monacoEditor ? _monacoEditor.getValue() : tab.content
            })
        });
        if (res.ok) {
            const data = await res.json();
            uiModule.showToast(`Saved as ${newPath}`);
            tab.path = data.path;
            tab.name = newPath.split('/').pop();
            tab.isDirty = false;
            _updateEditorContent();
            _renderTabStrip();
            refreshExplorer();
        } else {
            uiModule.showError('Failed to Save As file');
        }
    } catch(err) {
        uiModule.showError(`Save As error: ${err.message}`);
    }
}

function _toggleAutoSave() {
    _autoSaveEnabled = !_autoSaveEnabled;
    const checkEl = document.getElementById('ide-menu-autosave-check');
    if (checkEl) {
        checkEl.style.display = _autoSaveEnabled ? 'inline' : 'none';
    }
    uiModule.showToast(`Auto Save is now ${_autoSaveEnabled ? 'ON' : 'OFF'}`);
}

function _closeActiveEditor() {
    if (_activeTabIdx >= 0) {
        _closeTab(_activeTabIdx);
    }
}

async function _closeFolder() {
    _workspaceRoot = '';
    _openTabs = [];
    _activeTabIdx = -1;
    if (_monacoEditor) {
        try { _monacoEditor.dispose(); } catch(_) {}
        _monacoEditor = null;
    }
    _renderWelcomePage();
    _renderTimeline(null);
    _renderOutline();
    const filesContentEl = document.getElementById('ide-section-files-content');
    if (filesContentEl) {
        filesContentEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">No folder open.</div>';
    }
    uiModule.showToast('Workspace folder closed');
}

function _populateRecentSubmenu(submenu) {
    if (!submenu) return;
    submenu.innerHTML = '';
    let recents = [];
    try {
        recents = JSON.parse(localStorage.getItem('ide-recent-workspaces')) || [];
    } catch(e) {}
    
    if (recents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ide-dropdown-item';
        empty.style.padding = '6px 12px';
        empty.style.opacity = '0.5';
        empty.style.cursor = 'default';
        empty.textContent = 'No Recent Folders';
        submenu.appendChild(empty);
        return;
    }

    recents.forEach(path => {
        const item = document.createElement('div');
        item.className = 'ide-dropdown-item';
        item.style.padding = '6px 12px';
        item.style.cursor = 'pointer';
        // Use textContent so a malicious localStorage value can't break out
        // of the attribute / innerHTML boundary. Same goes for the title.
        item.textContent = path.split('/').pop() || path;
        item.title = path;
        item.onclick = (e) => {
            e.stopPropagation();
            _changeWorkspaceFolder(path);
            document.querySelectorAll('.ide-menu-dropdown').forEach(d => d.classList.add('hidden'));
        };
        submenu.appendChild(item);
    });
}
// Save modification back to disk
export async function saveCurrentFile() {
    if (_activeTabIdx < 0 || _activeTabIdx >= _openTabs.length) return;
    
    const tab = _openTabs[_activeTabIdx];
    let editorVal = '';
    
    if (_monacoLoaded && _monacoEditor) {
        editorVal = _monacoEditor.getValue();
    } else {
        const textarea = document.getElementById('ide-fallback-editor');
        if (textarea) editorVal = textarea.value;
    }

    try {
        const res = await fetch(`${API_BASE}/api/ide/write_file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: tab.path,
                content: editorVal
            })
        });

        if (res.ok) {
            tab.content = editorVal;
            _markTabDirty(false);
            uiModule.showToast(`Saved ${tab.name} successfully`);
        } else {
            throw new Error('Save server response error');
        }
    } catch (e) {
        uiModule.showError(`Failed to save file: ${e.message}`);
    }
}

// Run current script/file inside terminal
export async function runCurrentFile() {
    if (_activeTabIdx < 0 || _activeTabIdx >= _openTabs.length) return;
    
    const tab = _openTabs[_activeTabIdx];
    
    // Auto-save first
    await saveCurrentFile();
    
    // Switch active bottom panel to open terminal
    const bottomPanel = document.getElementById('ide-bottom-panel');
    bottomPanel.classList.remove('collapsed');
    document.getElementById('ide-terminal-toggle').textContent = '▼';

    let runCmd = '';
    const ext = tab.name.split('.').pop().toLowerCase();
    
    if (ext === 'py') {
        runCmd = `python3 ${tab.path}`;
    } else if (ext === 'js') {
        runCmd = `node ${tab.path}`;
    } else if (ext === 'sh' || ext === 'bash') {
        runCmd = `bash ${tab.path}`;
    } else {
        _printTerminal(`\nCannot run file: unsupported script format (.${ext})\n\n$ `);
        return;
    }

    _printTerminal(`\nRunning command: ${runCmd}\n`);
    _executeTerminalCommand(runCmd);
}

// ──────────────────────────────────────────
// Tab 2: Integrated Origin Chat Tab
// ──────────────────────────────────────────
function _renderIntegratedChat(container) {
    container.innerHTML = `
        <div class="ide-integrated-chat">
            <div class="ide-chat-history" id="ide-chat-history">
                <div class="ide-chat-message assistant">
                    Hello! I am your Origin AI assistant. Ask me questions or prompt me to write/refactor code for you.
                </div>
            </div>
            <div class="ide-chat-input-area">
                <input type="text" class="ide-chat-input" id="ide-chat-input" placeholder="Type prompt..." autocomplete="off" />
                <button class="ide-toolbar-btn primary" id="ide-chat-send-btn" style="height:28px;padding:0 8px;">Send</button>
            </div>
        </div>
    `;

    const chatInput = document.getElementById('ide-chat-input');
    const sendBtn = document.getElementById('ide-chat-send-btn');
    
    const triggerSend = async () => {
        const text = chatInput.value.trim();
        if (!text) return;

        chatInput.value = '';
        _appendIntegratedChatMessage('user', text);

        // Use the active Origin session
        const sessionId = window.sessionModule ? window.sessionModule.getCurrentSessionId() : null;
        if (!sessionId) {
            _appendIntegratedChatMessage('assistant', 'Please select or start a chat session in the main Origin window first to use the integrated chat.');
            return;
        }

        const assistantBubble = _appendIntegratedChatMessage('assistant', '⠋ Thinking...');

        try {
            // Use the non-streaming /api/chat endpoint (correct field: 'session' not 'session_id')
            const res = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    session: sessionId,
                    message: text
                })
            });

            if (res.ok) {
                const data = await res.json();
                // Backend returns { response: ... } not { message: ... }
                assistantBubble.textContent = data.response || 'No reply received.';
            } else {
                const err = await res.json().catch(() => ({}));
                assistantBubble.textContent = `Error: ${err.detail || 'Failed to fetch AI reply.'}`;
            }

        } catch (e) {
            assistantBubble.textContent = `Connection error: ${e.message}`;
        }
    };

    sendBtn.addEventListener('click', triggerSend);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') triggerSend();
    });
}

function _appendIntegratedChatMessage(role, text) {
    const history = document.getElementById('ide-chat-history');
    if (!history) return null;

    const el = document.createElement('div');
    el.className = `ide-chat-message ${role}`;
    el.textContent = text;
    history.appendChild(el);
    history.scrollTop = history.scrollHeight;
    return el;
}

// ──────────────────────────────────────────
// Tab 3: Integrated Google Keep-style Notes Tab
// ──────────────────────────────────────────
async function _renderIntegratedNotes(container) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.4;padding:8px;">Loading notes...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/notes`);
        if (!res.ok) throw new Error('Notes server response error');
        const notes = await res.json();

        container.innerHTML = '';
        if (notes.length === 0) {
            container.innerHTML = '<div style="font-size:11px;opacity:0.4;padding:8px;">No notes found in workspace.</div>';
            return;
        }

        notes.forEach(note => {
            const card = document.createElement('div');
            card.className = 'ide-note-item';
            // Use DOM APIs + textContent so a malicious note (created via
            // the notes API without sanitization) can't inject HTML here.
            const titleEl = document.createElement('div');
            titleEl.className = 'ide-note-title';
            titleEl.style.color = note.color || 'var(--fg)';
            titleEl.textContent = note.title || 'Untitled Note';
            const bodyEl = document.createElement('div');
            bodyEl.className = 'ide-note-body';
            bodyEl.textContent = note.body || '';
            card.appendChild(titleEl);
            card.appendChild(bodyEl);
            
            card.addEventListener('click', () => {
                // Open note title and body into active editor if editable
                const noteTitle = note.title || 'Untitled Note';
                const noteBody = note.body || '';
                const noteText = `# ${noteTitle}\n\n${noteBody}`;
                
                // Add virtual note tab
                _openTabs.push({
                    path: `note-${note.id}.md`,
                    name: `${noteTitle.substring(0, 12)}.md`,
                    content: noteText,
                    isDirty: false
                });
                _activeTabIdx = _openTabs.length - 1;
                _updateEditorContent();
                _renderTabStrip();
            });

            container.appendChild(card);
        });

    } catch (e) {
        container.innerHTML = `<div style="font-size:11px;color:var(--color-error);padding:8px;">Notes failed: ${_escHtml(e.message)}</div>`;
    }
}

// ──────────────────────────────────────────
// Tab 4: Integrated Scheduler Tasks Tab
// ──────────────────────────────────────────
async function _renderIntegratedTasks(container) {
    container.innerHTML = '<div style="font-size:11px;opacity:0.4;padding:8px;">Loading scheduler runs...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/tasks`);
        if (!res.ok) throw new Error('Tasks fetch response error');
        const data = await res.json();
        
        container.innerHTML = '';
        const tasks = data.tasks || [];
        if (tasks.length === 0) {
            container.innerHTML = '<div style="font-size:11px;opacity:0.4;padding:8px;">No active background scheduler runs.</div>';
            return;
        }

        tasks.forEach(task => {
            const el = document.createElement('div');
            el.style.padding = '8px';
            el.style.border = '1px solid var(--border)';
            el.style.borderRadius = '4px';
            el.style.marginBottom = '6px';
            el.style.fontSize = '11.5px';

            const isEnabled = task.enabled !== false;
            const head = document.createElement('div');
            head.style.cssText = 'font-weight:bold;display:flex;justify-content:space-between;gap:8px;';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = task.name;
            const stateSpan = document.createElement('span');
            stateSpan.style.cssText = `color:${isEnabled ? 'var(--green)' : 'var(--color-muted)'};font-size:10px;`;
            stateSpan.textContent = isEnabled ? 'active' : 'paused';
            head.appendChild(nameSpan);
            head.appendChild(stateSpan);
            const sched = document.createElement('div');
            sched.style.cssText = 'opacity:0.6;font-size:10px;margin-top:2px;';
            sched.textContent = `Schedule: ${task.schedule || 'on demand'}`;
            el.appendChild(head);
            el.appendChild(sched);
            container.appendChild(el);
        });

    } catch (e) {
        container.innerHTML = `<div style="font-size:11px;color:var(--color-error);padding:8px;">Tasks failed: ${_escHtml(e.message)}</div>`;
    }
}

// ──────────────────────────────────────────
// Terminal Command Execution implementation
// ──────────────────────────────────────────
function _ansiToHtml(text) {
    // Escape HTML to prevent XSS
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const ansiCodes = {
        '0': '</span>',
        '1': '<span style="font-weight:bold;">',
        '31': '<span style="color:#f14c4c;">', // red
        '32': '<span style="color:#23d18b;">', // green
        '33': '<span style="color:#f5f543;">', // yellow
        '34': '<span style="color:#3b8eea;">', // blue
        '35': '<span style="color:#d670d6;">', // magenta
        '36': '<span style="color:#29b8db;">', // cyan
        '37': '<span style="color:#e5e5e5;">', // white
        '90': '<span style="color:#7f7f7f;">', // gray
    };

    let result = escaped.replace(/\u001b\[([0-9;]+)m/g, (match, codes) => {
        let html = '';
        codes.split(';').forEach(code => {
            if (ansiCodes[code]) {
                html += ansiCodes[code];
            } else if (code === '0') {
                html += '</span>';
            }
        });
        return html;
    });

    // Close any unclosed spans
    let openSpans = (result.match(/<span/g) || []).length;
    let closeSpans = (result.match(/<\/span/g) || []).length;
    for (let i = 0; i < openSpans - closeSpans; i++) {
        result += '</span>';
    }

    return result;
}

function _printTerminal(text) {
    const termOutput = document.getElementById('ide-terminal-output');
    if (!termOutput) return;

    termOutput.innerHTML += _ansiToHtml(text);
    
    // Auto Scroll bottom
    const termBody = document.getElementById('ide-terminal-body');
    if (termBody) {
        termBody.scrollTop = termBody.scrollHeight;
    }
}

async function _executeTerminalCommand(commandString) {
    _printTerminal(`${commandString}\n`);
    
    try {
        // Fire endpoint using existing api/shell/exec
        const res = await fetch(`${API_BASE}/api/shell/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: commandString,
                use_pty: false
            })
        });

        if (res.ok) {
            const data = await res.json();
            if (data.stdout) {
                _printTerminal(data.stdout);
            }
            if (data.stderr) {
                _printTerminal(`\x1b[31m${data.stderr}\x1b[0m\n`);
            }
            _printTerminal(`\nCommand exited with code ${data.exit_code || 0}\n\n$ `);
        } else {
            const data = await res.json();
            _printTerminal(`\x1b[31mError: ${data.detail || 'Execution failed'}\x1b[0m\n\n$ `);
        }

    } catch (e) {
        _printTerminal(`\x1b[31mConnection error: ${e.message}\x1b[0m\n\n$ `);
    }
}

// ──────────────────────────────────────────
// File tree action helpers & context menus
// ──────────────────────────────────────────

function _getFileIcon(name, isDir, isExpanded = false) {
    if (isDir) {
        if (isExpanded) {
            return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e8a838" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
        }
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e8a838" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    }

    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'js' || ext === 'ts') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f7df1e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M9 17v-2a2 2 0 0 1 4 0v2"/><path d="M15 13v4"/></svg>`;
    }
    if (ext === 'py') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3776ab" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
    }
    if (ext === 'html') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#e34f26" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>`;
    }
    if (ext === 'css') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1572b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="7.5 10.5 12 13 16.5 10.5"/></svg>`;
    }
    if (ext === 'md') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#0080ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><path d="M7 15V9l3.5 4L14 9v6M17 11.5l1.5 1.5 1.5-1.5M18.5 9v4"/></svg>`;
    }
    if (ext === 'sh' || ext === 'bash' || ext === 'bat') {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4eb848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
    }
    if (['json', 'yml', 'yaml', 'toml', 'env', 'example', 'lock'].includes(ext) || name.startsWith('.')) {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#cbcb41" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h6"/></svg>`;
    }
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#858585" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

function _showContextMenu(e, file) {
    e.preventDefault();
    e.stopPropagation();

    const existing = document.querySelector('.ide-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'ide-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    if (file.is_dir) {
        const itemNewFile = document.createElement('div');
        itemNewFile.className = 'ide-context-menu-item';
        const t1 = document.createElement('span');
        t1.textContent = 'New File...';
        itemNewFile.appendChild(t1);
        itemNewFile.onclick = (evt) => {
            evt.stopPropagation();
            _createNewFileIn(file.rel_path);
            menu.remove();
        };
        menu.appendChild(itemNewFile);

        const itemNewFolder = document.createElement('div');
        itemNewFolder.className = 'ide-context-menu-item';
        const t2 = document.createElement('span');
        t2.textContent = 'New Folder...';
        itemNewFolder.appendChild(t2);
        itemNewFolder.onclick = (evt) => {
            evt.stopPropagation();
            _createNewFolderIn(file.rel_path);
            menu.remove();
        };
        menu.appendChild(itemNewFolder);

        const sep = document.createElement('div');
        sep.className = 'ide-context-menu-separator';
        menu.appendChild(sep);
    }

    const itemRename = document.createElement('div');
    itemRename.className = 'ide-context-menu-item';
    const t3 = document.createElement('span');
    t3.textContent = 'Rename...';
    itemRename.appendChild(t3);
    itemRename.onclick = (evt) => {
        evt.stopPropagation();
        _renameItem(file);
        menu.remove();
    };
    menu.appendChild(itemRename);

    const itemDelete = document.createElement('div');
    itemDelete.className = 'ide-context-menu-item';
    const t4 = document.createElement('span');
    t4.style.color = '#f14c4c';
    t4.textContent = 'Delete';
    itemDelete.appendChild(t4);
    itemDelete.onclick = (evt) => {
        evt.stopPropagation();
        _deleteItem(file);
        menu.remove();
    };
    menu.appendChild(itemDelete);

    document.body.appendChild(menu);

    const hideMenu = () => {
        menu.remove();
        document.removeEventListener('click', hideMenu);
        document.removeEventListener('contextmenu', hideMenu);
    };
    setTimeout(() => {
        document.addEventListener('click', hideMenu);
        document.addEventListener('contextmenu', hideMenu);
    }, 10);
}

async function _createNewFile() {
    const filename = prompt('Enter name of new file:');
    if (!filename) return;

    try {
        const res = await fetch(`${API_BASE}/api/ide/write_file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: filename,
                content: ''
            })
        });

        if (res.ok) {
            const data = await res.json();
            uiModule.showToast(`File ${filename} created`);
            await refreshExplorer();
            await openFile(data.path, filename);
        } else {
            const err = await res.json();
            uiModule.showError(`Failed to create file: ${err.detail || 'Write failed'}`);
        }
    } catch (e) {
        uiModule.showError(`Error creating file: ${e.message}`);
    }
}

async function _createNewFolder() {
    const foldername = prompt('Enter name of new folder:');
    if (!foldername) return;

    try {
        const res = await fetch(`${API_BASE}/api/ide/create_folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: foldername
            })
        });

        if (res.ok) {
            uiModule.showToast(`Folder ${foldername} created`);
            await refreshExplorer();
        } else {
            const err = await res.json();
            uiModule.showError(`Failed to create folder: ${err.detail || 'Folder already exists'}`);
        }
    } catch (e) {
        uiModule.showError(`Error creating folder: ${e.message}`);
    }
}

async function _createNewFileIn(dirRelPath) {
    const filename = prompt('Enter name of new file:');
    if (!filename) return;

    const fullRelPath = dirRelPath ? `${dirRelPath}/${filename}` : filename;

    try {
        const res = await fetch(`${API_BASE}/api/ide/write_file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: fullRelPath,
                content: ''
            })
        });

        if (res.ok) {
            const data = await res.json();
            uiModule.showToast(`File ${filename} created`);
            await refreshExplorer();
            await openFile(data.path, filename);
        } else {
            const err = await res.json();
            uiModule.showError(`Failed to create file: ${err.detail || 'Write failed'}`);
        }
    } catch (e) {
        uiModule.showError(`Error creating file: ${e.message}`);
    }
}

async function _createNewFolderIn(dirRelPath) {
    const foldername = prompt('Enter name of new folder:');
    if (!foldername) return;

    const fullRelPath = dirRelPath ? `${dirRelPath}/${foldername}` : foldername;

    try {
        const res = await fetch(`${API_BASE}/api/ide/create_folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: fullRelPath
            })
        });

        if (res.ok) {
            uiModule.showToast(`Folder ${foldername} created`);
            await refreshExplorer();
        } else {
            const err = await res.json();
            uiModule.showError(`Failed to create folder: ${err.detail || 'Folder already exists'}`);
        }
    } catch (e) {
        uiModule.showError(`Error creating folder: ${e.message}`);
    }
}

async function _renameItem(file) {
    const newName = prompt(`Rename "${file.name}" to:`, file.name);
    if (!newName || newName === file.name) return;

    const targetParent = file.path.substring(0, file.path.lastIndexOf('/'));
    const newPath = `${targetParent}/${newName}`;

    try {
        const res = await fetch(`${API_BASE}/api/ide/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: file.path,
                new_path: newPath
            })
        });

        if (res.ok) {
            uiModule.showToast(`Renamed successfully`);
            const tabIdx = _openTabs.findIndex(t => t.path === file.path);
            if (tabIdx >= 0) {
                _openTabs[tabIdx].path = newPath;
                _openTabs[tabIdx].name = newName;
                _renderTabStrip();
            }
            await refreshExplorer();
        } else {
            const err = await res.json();
            uiModule.showError(`Rename failed: ${err.detail || 'Directory issue'}`);
        }
    } catch (e) {
        uiModule.showError(`Error renaming: ${e.message}`);
    }
}

async function _deleteItem(file) {
    if (!confirm(`Are you sure you want to delete "${file.name}"? This action is permanent.`)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/ide/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: file.path
            })
        });

        if (res.ok) {
            uiModule.showToast(`Deleted ${file.name}`);
            const tabIdx = _openTabs.findIndex(t => t.path === file.path);
            if (tabIdx >= 0) {
                _openTabs.splice(tabIdx, 1);
                if (_activeTabIdx === tabIdx) {
                    _activeTabIdx = _openTabs.length - 1;
                } else if (_activeTabIdx > tabIdx) {
                    _activeTabIdx--;
                }
                if (_openTabs.length === 0) {
                    _activeTabIdx = -1;
                    _monacoEditor = null;
                    _renderWelcomePage();
                } else {
                    _updateEditorContent();
                }
                _renderTabStrip();
            }
            await refreshExplorer();
        } else {
            const err = await res.json();
            uiModule.showError(`Delete failed: ${err.detail || 'Write permission error'}`);
        }
    } catch (e) {
        uiModule.showError(`Error deleting: ${e.message}`);
    }
}

// Welcome Page renderer
function _renderWelcomePage() {
    const container = document.getElementById('ide-editor-container');
    if (!container) return;

    // Hide editor toolbar
    const toolbar = document.getElementById('ide-editor-toolbar');
    if (toolbar) toolbar.style.display = 'none';

    // Retrieve recents from localStorage
    let recents = [];
    try {
        recents = JSON.parse(localStorage.getItem('ide-recent-workspaces')) || [];
    } catch(e) {}

    // Fallback if empty, add current workspace or some default ones
    if (recents.length === 0 && _workspaceRoot) {
        recents.push(_workspaceRoot);
    }

    // Build recents list HTML — escape user-supplied path/name to avoid XSS
    // (a malicious localStorage value or saved workspace name with quotes/<>
    // would otherwise get injected as raw HTML when we use innerHTML below).
    const _esc = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    let recentsHtml = '';
    recents.forEach(path => {
        const name = path.split('/').pop() || path;
        recentsHtml += `
            <div class="welcome-recent-item" data-path="${_esc(path)}">
                <span class="welcome-recent-name">${_esc(name)}</span>
                <span class="welcome-recent-path">${_esc(path)}</span>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="vscode-welcome">
            <div class="welcome-title-row">
                <h1 class="welcome-title">Visual Studio Code</h1>
                <p class="welcome-subtitle">Editing evolved</p>
            </div>
            <div class="welcome-grid">
                <div class="welcome-column">
                    <div class="welcome-column-header">Start</div>
                    <div class="welcome-action-item" id="welcome-new-file">
                        <span class="welcome-action-icon">📄</span>
                        <span class="welcome-action-label">New File...</span>
                    </div>
                    <div class="welcome-action-item" id="welcome-open-folder">
                        <span class="welcome-action-icon">📂</span>
                        <span class="welcome-action-label">Open...</span>
                    </div>
                    <div class="welcome-action-item" id="welcome-clone-repo">
                        <span class="welcome-action-icon">🌿</span>
                        <span class="welcome-action-label">Clone Git Repository...</span>
                    </div>
                    <div class="welcome-action-item" id="welcome-connect">
                        <span class="welcome-action-icon">🔌</span>
                        <span class="welcome-action-label">Connect to...</span>
                    </div>
                    <div class="welcome-action-item" id="welcome-new-workspace">
                        <span class="welcome-action-icon">📁</span>
                        <span class="welcome-action-label">Generate New Workspace...</span>
                    </div>
                </div>
                <div class="welcome-column">
                    <div class="welcome-column-header">Recent</div>
                    <div class="welcome-recents-list">
                        ${recentsHtml || '<div style="font-size:11px; opacity:0.5; padding:6px;">No recent workspaces.</div>'}
                    </div>
                </div>
            </div>
            <div class="welcome-footer">
                <button class="welcome-agents-btn" id="welcome-agents-btn">
                    <span>Try out the new Agents window</span>
                </button>
                <div class="welcome-startup-row">
                    <input type="checkbox" id="welcome-startup-checkbox" checked />
                    <label for="welcome-startup-checkbox">Show welcome page on startup</label>
                </div>
            </div>
        </div>
    `;

    // Wire actions
    const newFileBtn = document.getElementById('welcome-new-file');
    if (newFileBtn) {
        newFileBtn.onclick = (e) => {
            e.stopPropagation();
            _createNewFile();
        };
    }

    const openFolderBtn = document.getElementById('welcome-open-folder');
    if (openFolderBtn) {
        openFolderBtn.onclick = (e) => {
            e.stopPropagation();
            _switchPanel('explorer');
            const pathInput = document.getElementById('ide-workspace-path-input');
            if (pathInput) {
                pathInput.focus();
                pathInput.select();
            }
        };
    }

    const cloneRepoBtn = document.getElementById('welcome-clone-repo');
    if (cloneRepoBtn) {
        cloneRepoBtn.onclick = (e) => {
            e.stopPropagation();
            const repoUrl = prompt('Enter Git repository URL to clone:');
            if (!repoUrl) return;
            const bottomPanel = document.getElementById('ide-bottom-panel');
            if (bottomPanel) bottomPanel.classList.remove('collapsed');
            const termToggler = document.getElementById('ide-terminal-toggle');
            if (termToggler) termToggler.textContent = '▼';
            _executeTerminalCommand(`git clone ${repoUrl}`);
        };
    }

    const connectBtn = document.getElementById('welcome-connect');
    if (connectBtn) {
        connectBtn.onclick = (e) => {
            e.stopPropagation();
            uiModule.showToast('Connecting to remote SSH workspace...');
        };
    }

    const newWorkspaceBtn = document.getElementById('welcome-new-workspace');
    if (newWorkspaceBtn) {
        newWorkspaceBtn.onclick = (e) => {
            e.stopPropagation();
            uiModule.showToast('Generating temporary workspace environment...');
        };
    }

    // Wire recents clicks
    container.querySelectorAll('.welcome-recent-item').forEach(item => {
        item.onclick = async (e) => {
            e.stopPropagation();
            const path = item.dataset.path;
            if (!path) return;
            try {
                const res = await fetch(`${API_BASE}/api/ide/workspace`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path })
                });
                if (res.ok) {
                    const data = await res.json();
                    _workspaceRoot = data.root;
                    uiModule.showToast('Loaded workspace: ' + path);
                    _saveToRecents(_workspaceRoot);
                    await refreshExplorer();
                    _renderWelcomePage();
                } else {
                    const err = await res.json();
                    uiModule.showError(`Failed to load folder: ${err.detail || 'Folder does not exist'}`);
                }
            } catch(err) {
                uiModule.showError(`Error loading recent workspace: ${err.message}`);
            }
        };
    });

    // Agents button
    const agentsBtn = document.getElementById('welcome-agents-btn');
    if (agentsBtn) {
        agentsBtn.onclick = (e) => {
            e.stopPropagation();
            uiModule.showToast('Opening Agents orchestration pane...');
        };
    }
}

function _saveToRecents(path) {
    if (!path) return;
    try {
        let recents = JSON.parse(localStorage.getItem('ide-recent-workspaces')) || [];
        recents = recents.filter(p => p !== path);
        recents.unshift(path);
        if (recents.length > 5) recents = recents.slice(0, 5);
        localStorage.setItem('ide-recent-workspaces', JSON.stringify(recents));
    } catch(e) {}
}

function _textareaCharOffsetForLine(textarea, targetLine) {
    // Computes the character offset in textarea.value for the start of `targetLine`
    // (1-indexed). Used by the outline + search panels to scroll/position the
    // caret when Monaco isn't available. The previous implementation called
    // `.length` on a substring, which returned a meaningless number on any
    // string with multi-byte chars and produced offsets that pointed past EOF.
    if (!textarea || targetLine < 1) return 0;
    const value = textarea.value || '';
    let line = 1;
    for (let i = 0; i < value.length; i++) {
        if (line === targetLine) return i;
        if (value.charCodeAt(i) === 10) line++; // '\n'
    }
    // If the requested line is past the last newline, clamp to EOF.
    return value.length;
}

// Outline Generator
function _renderOutline() {
    const outlineEl = document.getElementById('ide-section-outline-content');
    if (!outlineEl) return;

    if (_activeTabIdx < 0 || _activeTabIdx >= _openTabs.length) {
        outlineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">No active file.</div>';
        return;
    }

    const tab = _openTabs[_activeTabIdx];
    let content = '';
    if (_monacoLoaded && _monacoEditor) {
        content = _monacoEditor.getValue();
    } else {
        const textarea = document.getElementById('ide-fallback-editor');
        if (textarea) content = textarea.value;
    }

    if (!content) {
        outlineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">Empty file.</div>';
        return;
    }

    const ext = tab.name.split('.').pop().toLowerCase();
    const symbols = [];
    const lines = content.split('\n');

    if (ext === 'py') {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const defMatch = line.match(/^\s*(def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (defMatch) {
                const type = defMatch[1];
                const name = defMatch[2];
                const indent = line.search(/\S/);
                symbols.push({
                    name: name,
                    type: type,
                    lineNum: i + 1,
                    depth: Math.floor(indent / 4)
                });
            }
        }
    } else if (ext === 'js' || ext === 'ts' || ext === 'html') {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            let match = line.match(/^\s*(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (match) {
                const indent = line.search(/\S/);
                symbols.push({ name: match[1], type: 'function', lineNum: i + 1, depth: Math.floor(indent / 4) });
                continue;
            }

            match = line.match(/^\s*(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/);
            if (match) {
                const indent = line.search(/\S/);
                symbols.push({ name: match[1], type: 'arrow', lineNum: i + 1, depth: Math.floor(indent / 4) });
                continue;
            }

            match = line.match(/^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (match) {
                const indent = line.search(/\S/);
                symbols.push({ name: match[1], type: 'class', lineNum: i + 1, depth: Math.floor(indent / 4) });
                continue;
            }
            
            match = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{/);
            if (match) {
                const name = match[1];
                const reserved = ['if', 'for', 'while', 'switch', 'catch', 'constructor'];
                if (!reserved.includes(name)) {
                    const indent = line.search(/\S/);
                    symbols.push({ name: name, type: 'method', lineNum: i + 1, depth: Math.floor(indent / 4) });
                }
            }
        }
    }

    if (symbols.length === 0) {
        outlineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">No symbols found.</div>';
        return;
    }

    outlineEl.innerHTML = '';
    symbols.forEach(sym => {
        const item = document.createElement('div');
        item.className = 'ide-outline-item';
        item.style.paddingLeft = `${8 + sym.depth * 12}px`;

        let icon = '⚡';
        if (sym.type === 'class') icon = '🔷';
        else if (sym.type === 'def' || sym.type === 'function') icon = 'ƒ';
        else if (sym.type === 'method') icon = '○';

        // Use textContent / safe DOM construction so a weird symbol
        // name (e.g. one that came from a partially-parsed file) can't
        // smuggle markup into the outline panel.
        const iconSpan = document.createElement('span');
        iconSpan.style.cssText = 'opacity:0.7; font-size:10px;';
        iconSpan.textContent = icon;
        const nameSpan = document.createElement('span');
        nameSpan.style.fontFamily = 'monospace';
        nameSpan.textContent = sym.name;
        const lineSpan = document.createElement('span');
        lineSpan.style.cssText = 'margin-left:auto; opacity:0.4; font-size:9px;';
        lineSpan.textContent = `:${sym.lineNum}`;
        item.appendChild(iconSpan);
        item.appendChild(nameSpan);
        item.appendChild(lineSpan);

        item.onclick = (e) => {
            e.stopPropagation();
            if (_monacoLoaded && _monacoEditor) {
                _monacoEditor.revealLineInCenter(sym.lineNum);
                _monacoEditor.setPosition({ lineNumber: sym.lineNum, column: 1 });
                _monacoEditor.focus();
            } else {
                const textarea = document.getElementById('ide-fallback-editor');
                if (textarea) {
                    textarea.focus();
                    const offset = _textareaCharOffsetForLine(textarea, sym.lineNum);
                    textarea.setSelectionRange(offset, offset);
                }
            }
        };

        outlineEl.appendChild(item);
    });
}

// Git Timeline fetcher
async function _renderTimeline(filePath = null) {
    const timelineEl = document.getElementById('ide-section-timeline-content');
    if (!timelineEl) return;

    if (!filePath && _activeTabIdx >= 0 && _openTabs[_activeTabIdx]) {
        filePath = _openTabs[_activeTabIdx].path;
    }

    if (!filePath) {
        timelineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">No active file selected.</div>';
        return;
    }

    timelineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">Loading commits...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/ide/git_log?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) {
            throw new Error('Server returned status: ' + res.status);
        }
        const commits = await res.json();
        
        timelineEl.innerHTML = '';
        if (!commits || commits.length === 0) {
            timelineEl.innerHTML = '<div style="font-size:11px; opacity:0.5; padding:8px;">No commits.</div>';
            return;
        }

        commits.forEach(commit => {
            const item = document.createElement('div');
            item.className = 'ide-timeline-item';
            // Use textContent for every field — git commit messages can
            // contain anything (including ">" and "script" tags), so
            // innerHTML would be an XSS hole.
            const hashEl = document.createElement('div');
            hashEl.className = 'ide-timeline-hash';
            hashEl.textContent = commit.hash;
            const subjEl = document.createElement('div');
            subjEl.className = 'ide-timeline-subject';
            subjEl.textContent = commit.subject;
            const metaEl = document.createElement('div');
            metaEl.className = 'ide-timeline-meta';
            metaEl.textContent = `by ${commit.author} (${commit.relative_date})`;
            item.appendChild(hashEl);
            item.appendChild(subjEl);
            item.appendChild(metaEl);
            timelineEl.appendChild(item);
        });
    } catch(e) {
        timelineEl.innerHTML = `<div style="font-size:11px; color:var(--color-error); padding:8px;">Failed to load: ${_escHtml(e.message)}</div>`;
    }
}

// Git branch fetcher
async function _loadGitBranch() {
    const el = document.getElementById('status-git-branch-name');
    if (!el) return;
    try {
        const res = await fetch(`${API_BASE}/api/ide/git_branch`);
        if (res.ok) {
            const data = await res.json();
            el.textContent = data.branch || 'main';
        }
    } catch(e) {
        el.textContent = 'main';
    }
}

// Initialize Custom Model Picker dropdown in IDE Copilot panel
async function _initIdeModelPicker() {
    const wrap = document.getElementById('ide-model-picker-wrap');
    const btn = document.getElementById('ide-chat-badge-model');
    const menu = document.getElementById('ide-model-picker-menu');
    const search = document.getElementById('ide-model-picker-search');
    const listEl = document.getElementById('ide-model-picker-list');
    const addBtn = document.getElementById('ide-model-picker-add-btn');
    if (!wrap || !btn || !menu || !search || !listEl) return;

    btn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        document.querySelectorAll('.model-picker-menu').forEach(m => m.classList.add('hidden'));
        if (wasHidden) {
            menu.classList.remove('hidden');
            search.focus();
            _populateIdePicker();
        }
    };

    if (addBtn) {
        addBtn.onclick = (e) => {
            e.stopPropagation();
            menu.classList.add('hidden');
            if (window.settingsModule && typeof window.settingsModule.open === 'function') {
                window.settingsModule.open('services');
            } else if (window.adminModule && typeof window.adminModule.open === 'function') {
                window.adminModule.open('services');
            }
        };
    }

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) {
            menu.classList.add('hidden');
        }
    });

    search.oninput = () => {
        _populateIdePicker(search.value);
    };

    wrap.onkeydown = (e) => {
        if (menu.classList.contains('hidden')) return;
        if (e.key === 'Escape') {
            menu.classList.add('hidden');
            btn.focus();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const items = [...listEl.querySelectorAll('.model-switch-item')];
            if (!items.length) return;
            const cur = items.findIndex(el => el.classList.contains('kb-active'));
            items.forEach(el => el.classList.remove('kb-active'));
            let next;
            if (e.key === 'ArrowDown') next = cur < items.length - 1 ? cur + 1 : 0;
            else next = cur > 0 ? cur - 1 : items.length - 1;
            items[next].classList.add('kb-active');
            items[next].scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const active = listEl.querySelector('.model-switch-item.kb-active') || listEl.querySelector('.model-switch-item');
            if (active) active.click();
        }
    };

    // Initial check to populate label with current session model
    const currentModel = window.sessionModule ? window.sessionModule.getCurrentModel() : null;
    if (currentModel) {
        const labelSpan = document.getElementById('ide-chat-active-model');
        if (labelSpan) labelSpan.textContent = currentModel.split('/').pop().substring(0, 20);
    }
}

async function _populateIdePicker(filter = '') {
    const listEl = document.getElementById('ide-model-picker-list');
    const labelSpan = document.getElementById('ide-chat-active-model');
    const menu = document.getElementById('ide-model-picker-menu');
    if (!listEl) return;

    listEl.innerHTML = '';
    const q = filter.toLowerCase();

    // Default option
    const defaultRow = document.createElement('div');
    defaultRow.className = 'model-switch-item';
    
    const currentModel = window.sessionModule ? window.sessionModule.getCurrentModel() : null;
    if (!currentModel) {
        defaultRow.classList.add('selected');
    }
    
    defaultRow.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
            <span class="provider-logo" style="opacity: 0.8; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;">⚡</span>
            <span class="model-name" style="flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">Use current session model</span>
        </div>
        <span class="provider-name">System</span>
    `;
    defaultRow.onclick = () => {
        if (labelSpan) {
            labelSpan.textContent = 'Origin AI';
        }
        menu.classList.add('hidden');
    };
    listEl.appendChild(defaultRow);

    try {
        const res = await fetch(`${API_BASE}/api/models`, { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        const items = data.items || (Array.isArray(data) ? data : []);
        const seen = new Set();

        items.forEach(item => {
            if (item.offline) return;

            const allModels = (item.models || []).concat(item.models_extra || []);
            allModels.forEach(model => {
                if (seen.has(model)) return;
                seen.add(model);

                if (q && !model.toLowerCase().includes(q)) return;

                const row = document.createElement('div');
                row.className = 'model-switch-item';
                
                const isSelected = currentModel === model;
                if (isSelected) {
                    row.classList.add('selected');
                }

                const logoSvg = providerLogo(model) || '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';

                row.innerHTML = `
                    <div style="display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0;">
                        <span class="provider-logo">${logoSvg}</span>
                        <span class="model-name">${_escHtml(model.split('/').pop())}</span>
                    </div>
                    <span class="provider-name">${_escHtml(item.endpoint_name || 'API')}</span>
                `;

                row.onclick = async () => {
                    if (labelSpan) {
                        labelSpan.textContent = model.split('/').pop().substring(0, 20);
                    }
                    menu.classList.add('hidden');

                    const sessionId = window.sessionModule ? window.sessionModule.getCurrentSessionId() : null;
                    if (!sessionId) {
                        uiModule.showToast('Please start or select a chat session in the main window first.');
                        return;
                    }

                    const fd = new FormData();
                    fd.append('model', model);
                    fd.append('endpoint_url', item.url || '');
                    fd.append('endpoint_id', item.endpoint_id || '');

                    try {
                        const switchRes = await fetch(`${API_BASE}/api/session/${sessionId}`, {
                            method: 'PATCH',
                            credentials: 'same-origin',
                            body: fd
                        });
                        if (switchRes.ok) {
                            uiModule.showToast(`Switched active session model to ${model}`);
                            if (window.sessionModule && typeof window.sessionModule.updateModelPicker === 'function') {
                                window.sessionModule.updateModelPicker();
                            }
                        } else {
                            uiModule.showError('Failed to change session model');
                        }
                    } catch(err) {
                        uiModule.showError(`Error changing model: ${err.message}`);
                    }
                };

                listEl.appendChild(row);
            });
        });
    } catch(e) {}
}

function _initIdeMenuBar() {
    const menuItems = document.querySelectorAll('.ide-menu-item');
    let activeDropdown = null;

    menuItems.forEach(item => {
        const dropdown = item.querySelector('.ide-menu-dropdown');
        if (!dropdown) return;

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = dropdown.classList.contains('hidden');
            document.querySelectorAll('.ide-menu-dropdown').forEach(d => d.classList.add('hidden'));
            document.querySelectorAll('.ide-menu-item').forEach(mi => mi.style.backgroundColor = '');

            if (isHidden) {
                dropdown.classList.remove('hidden');
                item.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                activeDropdown = dropdown;
            } else {
                activeDropdown = null;
            }
        });

        item.addEventListener('mouseenter', () => {
            if (activeDropdown) {
                document.querySelectorAll('.ide-menu-dropdown').forEach(d => d.classList.add('hidden'));
                document.querySelectorAll('.ide-menu-item').forEach(mi => mi.style.backgroundColor = '');
                dropdown.classList.remove('hidden');
                item.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                activeDropdown = dropdown;
            } else {
                item.style.opacity = '1';
                item.style.backgroundColor = 'rgba(255, 255, 255, 0.04)';
            }
        });

        item.addEventListener('mouseleave', () => {
            if (!dropdown.classList.contains('hidden')) return;
            item.style.opacity = '0.8';
            item.style.backgroundColor = '';
        });
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.ide-menu-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('.ide-menu-item').forEach(mi => mi.style.backgroundColor = '');
        activeDropdown = null;
    });

    const bindAction = (id, fn) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                fn();
                document.querySelectorAll('.ide-menu-dropdown').forEach(d => d.classList.add('hidden'));
                activeDropdown = null;
            });
        }
    };

    bindAction('ide-menu-new-text-file', _createNewTextFile);
    bindAction('ide-menu-new-file', _createNewFile);
    bindAction('ide-menu-new-folder', _createNewFolder);
    bindAction('ide-menu-new-window', _createNewWindow);
    bindAction('ide-menu-open-folder', _openFolderPrompt);
    bindAction('ide-menu-save', saveCurrentFile);
    bindAction('ide-menu-save-as', _saveFileAs);
    bindAction('ide-menu-autosave', _toggleAutoSave);
    bindAction('ide-menu-close-editor', _closeActiveEditor);
    bindAction('ide-menu-close-folder', _closeFolder);
    bindAction('ide-menu-close', close);

    const checkEl = document.getElementById('ide-menu-autosave-check');
    if (checkEl) {
        checkEl.style.display = _autoSaveEnabled ? 'inline' : 'none';
    }

    const recentItem = document.getElementById('ide-menu-open-recent');
    if (recentItem) {
        const submenu = recentItem.querySelector('.ide-menu-submenu');
        recentItem.addEventListener('mouseenter', () => {
            _populateRecentSubmenu(submenu);
            submenu.classList.remove('hidden');
        });
        recentItem.addEventListener('mouseleave', () => {
            submenu.classList.add('hidden');
        });
    }

    bindAction('ide-menu-undo', () => {
        if (_monacoLoaded && _monacoEditor) {
            _monacoEditor.trigger('keyboard', 'undo', null);
            _monacoEditor.focus();
        } else {
            document.execCommand('undo');
        }
    });
    bindAction('ide-menu-redo', () => {
        if (_monacoLoaded && _monacoEditor) {
            _monacoEditor.trigger('keyboard', 'redo', null);
            _monacoEditor.focus();
        } else {
            document.execCommand('redo');
        }
    });

    bindAction('ide-menu-select-all', () => {
        if (_monacoLoaded && _monacoEditor) {
            const model = _monacoEditor.getModel();
            if (model) {
                _monacoEditor.setSelection(model.getFullModelRange());
                _monacoEditor.focus();
            }
        } else {
            const ta = document.getElementById('ide-fallback-editor');
            if (ta) {
                ta.focus();
                ta.select();
            }
        }
    });

    bindAction('ide-menu-toggle-sidebar', () => {
        const sidePanel = document.getElementById('ide-side-panel');
        if (sidePanel) {
            sidePanel.classList.toggle('collapsed');
            setTimeout(() => { if (_monacoEditor) _monacoEditor.layout(); }, 300);
        }
    });

    bindAction('ide-menu-toggle-terminal', () => {
        const bottomPanel = document.getElementById('ide-bottom-panel');
        if (bottomPanel) {
            bottomPanel.classList.toggle('collapsed');
            const toggler = document.getElementById('ide-terminal-toggle');
            if (toggler) toggler.textContent = bottomPanel.classList.contains('collapsed') ? '▲' : '▼';
            setTimeout(() => { if (_monacoEditor) _monacoEditor.layout(); }, 300);
        }
    });

    bindAction('ide-menu-go-explorer', () => _switchPanel('explorer'));
    bindAction('ide-menu-go-search', () => {
        _switchPanel('search');
        setTimeout(() => {
            const input = document.getElementById('ide-search-query-input');
            if (input) { input.focus(); input.select(); }
        }, 100);
    });

    bindAction('ide-menu-run-active', runCurrentFile);

    bindAction('ide-menu-clear-terminal', () => {
        const termOutput = document.getElementById('ide-terminal-output');
        if (termOutput) {
            // Re-emit the banner so the user keeps the same context (color,
            // version, workspace path) they had on first open. Setting just
            // '$ ' was confusing because it implied a previous command had
            // finished, when in reality we'd just erased the prompt.
            termOutput.innerHTML = '';
            _printTerminal(`\x1b[1;36mOrigin Integrated Workspace IDE v1.0.0\x1b[0m\nWorkspace Root: ${_workspaceRoot}\nType shell commands in the prompt below to execute.\n\n$ `);
        }
    });

    bindAction('ide-menu-about', () => {
        uiModule.showToast('Origin Integrated Workspace IDE v1.2.0. Powered by Monaco Editor.');
    });
}

// Copilot Message handlers — streaming SSE via /api/chat_stream
async function _sendCopilotMessage() {
    const textarea = document.getElementById('ide-right-chat-textarea');
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) return;

    // Get current session from Origin
    const sessionId = window.sessionModule ? window.sessionModule.getCurrentSessionId() : null;
    if (!sessionId) {
        _appendCopilotMessage('assistant', '⚠️ Please open or start a chat session in the main Origin window first. The IDE copilot uses your active session model.');
        return;
    }

    textarea.value = '';
    _appendCopilotMessage('user', text);

    const assistantBubble = _appendCopilotMessage('assistant', '⠋');
    if (!assistantBubble) return;

    // Build form data payload for /api/chat_stream (SSE streaming endpoint)
    const formData = new FormData();
    formData.append('message', text);
    formData.append('session', sessionId);
    formData.append('mode', 'chat');
    formData.append('allow_bash', 'false');
    formData.append('allow_web_search', 'false');

    // Inject current file context if available
    if (_activeTabIdx >= 0 && _openTabs[_activeTabIdx]) {
        const tab = _openTabs[_activeTabIdx];
        let content = '';
        if (_monacoLoaded && _monacoEditor) {
            content = _monacoEditor.getValue();
        } else {
            const ta = document.getElementById('ide-fallback-editor');
            if (ta) content = ta.value;
        }
        if (content) {
            formData.append('message', `[IDE context: ${tab.name}]\n\`\`\`\n${content.substring(0, 2000)}\n\`\`\`\n\nUser question: ${text}`);
        }
    }

    let fullText = '';
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    let spinTimer = setInterval(() => {
        if (assistantBubble && !fullText) {
            assistantBubble.textContent = spinFrames[spinIdx++ % spinFrames.length];
        }
    }, 100);

    try {
        const res = await fetch(`${API_BASE}/api/chat_stream`, {
            method: 'POST',
            credentials: 'same-origin',
            body: formData
        });

        if (!res.ok || !res.body) {
            clearInterval(spinTimer);
            // Fallback to non-streaming /api/chat
            const fallbackRes = await fetch(`${API_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ session: sessionId, message: text })
            });
            if (fallbackRes.ok) {
                const d = await fallbackRes.json();
                // Backend returns { response: ... }
                assistantBubble.textContent = d.response || 'No reply received.';
            } else {
                assistantBubble.textContent = 'Failed to get AI reply. Check your model settings.';
            }
            return;
        }

        clearInterval(spinTimer);
        assistantBubble.textContent = '';

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') break;
                try {
                    const evt = JSON.parse(payload);
                    if (evt.delta) {
                        fullText += evt.delta;
                        assistantBubble.textContent = fullText;
                        const chatMessages = document.getElementById('ide-right-chat-messages');
                        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
                    } else if (evt.type === 'model_info' && evt.model) {
                        const modelEl = document.getElementById('ide-chat-active-model');
                        if (modelEl) modelEl.textContent = evt.model.split('/').pop().substring(0, 20);
                    }
                } catch (_) {}
            }
        }

        if (!fullText) {
            assistantBubble.textContent = 'No response received. Try again or check your model connection.';
        }
    } catch(e) {
        clearInterval(spinTimer);
        assistantBubble.textContent = `Connection error: ${e.message}`;
    }
}

function _appendCopilotMessage(role, text) {
    const container = document.getElementById('ide-right-chat-messages');
    if (!container) return null;

    const el = document.createElement('div');
    el.className = `ide-right-chat-msg ${role}`;
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
}

function _renderWorkspaceSearch(container) {
    container.innerHTML = `
        <div class="ide-search-panel" style="display:flex; flex-direction:column; gap:10px; padding:10px; height:100%; box-sizing:border-box;">
            <div class="ide-search-input-wrapper" style="display:flex; flex-direction:column; gap:4px;">
                <input type="text" class="ide-workspace-input" id="ide-search-query-input" placeholder="Search text in files..." style="width:100%; box-sizing:border-box;" />
                <div style="font-size:10px; display:flex; justify-content:space-between; color: var(--fg); opacity: 0.6;">
                    <span>Press Enter to search</span>
                    <span id="ide-search-results-count"></span>
                </div>
            </div>
            <div class="ide-search-results" id="ide-search-results-list" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px;">
                <div style="font-size:11px; opacity:0.5; text-align:center; padding-top:20px;">Enter query to search workspace</div>
            </div>
        </div>
    `;

    const searchInput = document.getElementById('ide-search-query-input');
    const resultsList = document.getElementById('ide-search-results-list');
    const countEl = document.getElementById('ide-search-results-count');

    if (searchInput) {
        searchInput.focus();
        searchInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                const query = searchInput.value.trim();
                if (!query) return;

                resultsList.innerHTML = '<div style="font-size:11px; opacity:0.5; text-align:center; padding-top:20px;">Searching...</div>';
                countEl.textContent = '';

                try {
                    const res = await fetch(`${API_BASE}/api/ide/search?query=${encodeURIComponent(query)}`);
                    if (!res.ok) throw new Error('Search failed');
                    const results = await res.json();

                    resultsList.innerHTML = '';
                    if (results.length === 0) {
                        resultsList.innerHTML = '<div style="font-size:11px; opacity:0.5; text-align:center; padding-top:20px;">No results found.</div>';
                        countEl.textContent = '0 results';
                        return;
                    }

                    countEl.textContent = `${results.length} result(s)`;

                    // Group results by file path
                    const grouped = {};
                    results.forEach(resItem => {
                        if (!grouped[resItem.path]) {
                            grouped[resItem.path] = {
                                relPath: resItem.rel_path,
                                filename: resItem.rel_path.split('/').pop(),
                                matches: []
                            };
                        }
                        grouped[resItem.path].matches.push(resItem);
                    });

                    // Render grouped results
                    Object.keys(grouped).forEach(filePath => {
                        const group = grouped[filePath];
                        const fileNode = document.createElement('div');
                        fileNode.className = 'ide-search-file-group';
                        fileNode.style.display = 'flex';
                        fileNode.style.flexDirection = 'column';
                        fileNode.style.gap = '2px';

                        // File header
                        const header = document.createElement('div');
                        header.style.display = 'flex';
                        header.style.alignItems = 'center';
                        header.style.gap = '6px';
                        header.style.padding = '4px 6px';
                        header.style.cursor = 'pointer';
                        header.style.fontWeight = '600';
                        header.style.fontSize = '11.5px';
                        header.style.color = 'var(--accent, var(--red))';
                        header.style.borderRadius = '4px';
                        header.style.backgroundColor = 'rgba(255,255,255,0.03)';

                        // Build header with DOM APIs so a path / filename
                        // containing HTML can't smuggle in script tags.
                        const icon = document.createElement('span');
                        icon.textContent = '📄';
                        const nameSpan = document.createElement('span');
                        nameSpan.className = 'grow';
                        nameSpan.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex-grow: 1;';
                        nameSpan.textContent = group.filename;
                        nameSpan.title = group.relPath;
                        const countSpan = document.createElement('span');
                        countSpan.style.cssText = 'font-size:9.5px; opacity:0.5; margin-left: auto;';
                        countSpan.textContent = String(group.matches.length);
                        header.appendChild(icon);
                        header.appendChild(nameSpan);
                        header.appendChild(countSpan);

                        header.onclick = () => {
                            openFile(filePath, group.filename);
                        };

                        fileNode.appendChild(header);

                        const matchesContainer = document.createElement('div');
                        matchesContainer.style.display = 'flex';
                        matchesContainer.style.flexDirection = 'column';
                        matchesContainer.style.paddingLeft = '18px';

                        group.matches.forEach(match => {
                            const matchEl = document.createElement('div');
                            matchEl.className = 'ide-search-match-item';
                            matchEl.style.display = 'flex';
                            matchEl.style.alignItems = 'center';
                            matchEl.style.gap = '8px';
                            matchEl.style.padding = '3px 4px';
                            matchEl.style.cursor = 'pointer';
                            matchEl.style.fontSize = '11px';
                            matchEl.style.borderRadius = '3px';

                            const lineSpan = document.createElement('span');
                            lineSpan.style.cssText = 'opacity:0.4; font-family:monospace; min-width:20px; text-align:right;';
                            lineSpan.textContent = String(match.line);
                            const contentSpan = document.createElement('span');
                            contentSpan.style.cssText = 'font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.85;';
                            contentSpan.textContent = match.content;
                            contentSpan.title = match.content;
                            matchEl.appendChild(lineSpan);
                            matchEl.appendChild(contentSpan);

                            matchEl.onclick = async (evt) => {
                                evt.stopPropagation();
                                await openFile(filePath, group.filename);
                                // Reveal line in Monaco editor
                                setTimeout(() => {
                                    if (_monacoLoaded && _monacoEditor) {
                                        _monacoEditor.revealLineInCenter(match.line);
                                        _monacoEditor.setPosition({ lineNumber: match.line, column: 1 });
                                        _monacoEditor.focus();
                                    } else {
                                        const textarea = document.getElementById('ide-fallback-editor');
                                        if (textarea) {
                                            textarea.focus();
                                            const offset = _textareaCharOffsetForLine(textarea, match.line);
                                            textarea.setSelectionRange(offset, offset);
                                        }
                                    }
                                }, 150);
                            };

                            matchesContainer.appendChild(matchEl);
                        });

                        fileNode.appendChild(matchesContainer);
                        resultsList.appendChild(fileNode);
                    });
                } catch (err) {
                    resultsList.innerHTML = `<div style="font-size:11px; color:var(--color-error); text-align:center; padding-top:20px;">Search failed: ${_escHtml(err.message)}</div>`;
                }
            }
        });
    }
}

function _ideKeydownHandler(e) {
    const modal = document.getElementById('ide-modal');
    if (!modal || modal.classList.contains('hidden') || Modals.isMinimized('ide-modal')) {
        return;
    }

    // Don't hijack typing in a text input / textarea. The IDE shortcuts
    // (Ctrl+S, Ctrl+Shift+F, Cmd+B, etc.) would otherwise block normal
    // text editing in inputs like the workspace path, terminal, and the
    // integrated chat textarea.
    const target = e.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    const isEditable = tag === 'input' || tag === 'textarea'
        || (target && target.isContentEditable);
    // When Monaco is the focused element, let Monaco handle its own
    // keybindings (Ctrl+S is already wired via addCommand in init).
    const inMonaco = target && target.closest && target.closest('.monaco-editor');
    if (isEditable && !inMonaco) {
        return;
    }

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

    // Ctrl+B / Cmd+B toggles Left Side Panel
    if (isCmdOrCtrl && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const sidePanel = document.getElementById('ide-side-panel');
        if (sidePanel) {
            sidePanel.classList.toggle('collapsed');
            setTimeout(() => {
                if (_monacoEditor) _monacoEditor.layout();
            }, 300);
        }
    }

    // Ctrl+` (backtick) toggles Bottom Terminal
    if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        const bottomPanel = document.getElementById('ide-bottom-panel');
        if (bottomPanel) {
            bottomPanel.classList.toggle('collapsed');
            const toggler = document.getElementById('ide-terminal-toggle');
            if (toggler) {
                toggler.textContent = bottomPanel.classList.contains('collapsed') ? '▲' : '▼';
            }
            setTimeout(() => {
                if (_monacoEditor) _monacoEditor.layout();
            }, 300);
        }
    }

    // Alt+Cmd+N (or Alt+Ctrl+N) -> New Text File
    if (e.altKey && isCmdOrCtrl && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        _createNewTextFile();
    }

    // Shift+Cmd+N (or Shift+Ctrl+N) -> New Window
    if (e.shiftKey && isCmdOrCtrl && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        _createNewWindow();
    }

    // Alt+Cmd+O (or Alt+Ctrl+O) -> Open Folder
    if (e.altKey && isCmdOrCtrl && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        _openFolderPrompt();
    }

    // Shift+Cmd+S (or Shift+Ctrl+S) -> Save As
    if (e.shiftKey && isCmdOrCtrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        _saveFileAs();
    }

    // Cmd+W (or Ctrl+W) -> Close Editor
    if (isCmdOrCtrl && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        _closeActiveEditor();
    }

    // Ctrl+Shift+F (or Cmd+Shift+F) switches to search panel
    if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        _switchPanel('search');
        setTimeout(() => {
            const input = document.getElementById('ide-search-query-input');
            if (input) {
                input.focus();
                input.select();
            }
        }, 100);
    }
}

const ideModule = {
    open,
    close,
    openFile,
    saveCurrentFile,
    runCurrentFile
};

export default ideModule;

