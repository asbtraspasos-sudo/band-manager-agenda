/**
 * Band Manager - Core Logic
 * Supabase Cloud + IndexedDB Local Cache
 */

// --- CONFIGURACIÓN SUPABASE ---
// REEMPLAZA ESTOS VALORES CON LOS TUYOS
const SUPABASE_URL = 'https://jolpqgzkfunnflqwebzp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvbHBxZ3prZnVubmZscXdlYnpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjIxMDcsImV4cCI6MjA5MzYzODEwN30.uGPICSBblt4_hGHE8EBWfML54b1dc7gZLLdll4BfhQ0';
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const SCORES_BUCKET = 'scores';

// --- DATABASE HELPERS (IndexedDB - Local Cache) ---
const DB_NAME = 'BandManagerDB';
const DB_VERSION = 2;
const STORE_NAME = 'members';

const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

const getAllMembers = async () => {
    // 1. Intentar traer de Supabase
    if (supabase && navigator.onLine) {
        const { data, error } = await supabase.from('members').select('*');
        if (!error && data) {
            // Actualizar cache local
            const db = await initDB();
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            data.forEach(m => store.put(m));
            return data;
        }
    }

    // 2. Si falla o estamos offline, usar cache local
    const db = await initDB();
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
    });
};

const saveMember = async (member) => {
    // 1. Guardar en Supabase
    if (supabase && navigator.onLine) {
        await supabase.from('members').upsert(member);
    }

    // 2. Guardar en cache local (siempre)
    const db = await initDB();
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put(member);
        transaction.oncomplete = () => resolve();
    });
};

const deleteMemberFromDB = async (id) => {
    // 1. Eliminar de Supabase
    if (supabase && navigator.onLine) {
        await supabase.from('members').delete().eq('id', id);
    }

    // 2. Eliminar de cache local
    const db = await initDB();
    return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.delete(id);
        transaction.oncomplete = () => resolve();
    });
};

const sortScores = (scores) => {
    return scores.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const getScoreTitle = (fileName) => {
    return fileName.replace(/^\d+-/, '').replace(/\.pdf$/i, '').replace(/-/g, ' ');
};

const toSafeFileName = (fileName) => {
    return fileName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
};

const formatFileSize = (bytes) => {
    if (!bytes) return '0 KB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
};

const ensureScoresCanUseSupabase = () => {
    if (!supabase) {
        throw new Error('Supabase no está disponible.');
    }
    if (!navigator.onLine) {
        throw new Error('No hay conexión. Las partituras se guardan en Supabase.');
    }
};

const getAllScores = async () => {
    ensureScoresCanUseSupabase();

    const { data, error } = await supabase.storage
        .from(SCORES_BUCKET)
        .list('', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

    if (error) {
        throw new Error(error.message || 'No se pudieron cargar las partituras.');
    }

    return sortScores(data
        .filter(item => item.name.toLowerCase().endsWith('.pdf'))
        .map(item => ({
            id: item.id || item.name,
            title: getScoreTitle(item.name),
            fileName: item.name.replace(/^\d+-/, ''),
            path: item.name,
            size: item.metadata?.size || 0,
            createdAt: item.created_at || item.updated_at || new Date().toISOString()
        })));
};

const uploadScore = async (file) => {
    ensureScoresCanUseSupabase();

    const path = `${Date.now()}-${toSafeFileName(file.name)}`;
    const { data, error } = await supabase.storage
        .from(SCORES_BUCKET)
        .upload(path, file, { contentType: 'application/pdf', upsert: false });

    if (error) {
        throw new Error(error.message || 'No se pudo subir la partitura.');
    }

    return {
        id: data.path,
        title: file.name.replace(/\.pdf$/i, ''),
        fileName: file.name,
        path: data.path,
        size: file.size,
        createdAt: new Date().toISOString()
    };
};

// --- REACTIVE STATE ---
const state = new Proxy({
    members: [],
    scores: [],
    scoreMessage: '',
    view: 'list', // 'list' | 'add' | 'edit'
    selectedMember: null,
    isOnline: navigator.onLine
}, {
    set(target, property, value) {
        target[property] = value;
        render();
        return true;
    }
});

// --- UI COMPONENTS & RENDERING ---
const render = () => {
    const main = document.getElementById('main-content');
    const syncStatus = document.getElementById('sync-status');

    syncStatus.textContent = state.isOnline ? 'Cloud Sync On' : 'Offline Mode';
    syncStatus.className = `sync-status ${state.isOnline ? 'online' : 'offline'}`;

    if (state.view === 'list') {
        renderListView(main);
    } else if (state.view === 'add') {
        renderAddView(main);
    } else if (state.view === 'edit') {
        renderEditView(main);
    } else if (state.view === 'scores') {
        renderScoresView(main);
    }
};

const setActiveNav = (activeId) => {
    ['nav-list', 'nav-add', 'nav-scores'].forEach(id => {
        const item = document.getElementById(id);
        if (item) {
            item.classList.toggle('active', id === activeId);
        }
    });
};

const renderListView = (container) => {
    container.innerHTML = `
        <div class="animate-fade-in">
            <h1 style="margin-bottom: 1.5rem; font-weight: 800;">Músicos</h1>
            <div class="member-list">
                ${state.members.length === 0 ? `
                    <div class="empty-state">
                        <p>No hay miembros registrados.</p>
                        <button onclick="window.seedData()" class="btn-secondary">Cargar Datos de Ejemplo</button>
                    </div>
                ` : ''}
                ${state.members.map(m => `
                    <div class="member-card" onclick="window.editMember('${m.id}')">
                        <div class="member-info">
                            <h3>${m.name}</h3>
                            <p><span class="instrument-tag">${m.instrument}</span> • ${m.role}</p>
                        </div>
                        <div class="availability-toggle ${m.available ? 'active' : ''}" 
                             onclick="event.stopPropagation(); window.toggleAvailability('${m.id}')">
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    setActiveNav('nav-list');
};

const renderAddView = (container) => {
    container.innerHTML = `
        <div class="animate-fade-in">
            <h1 style="margin-bottom: 1.5rem; font-weight: 800;">NUEVO MIEMBRO</h1>
            <form id="member-form" class="form-container">
                <div class="input-group">
                    <label>Nombre Completo</label>
                    <input type="text" id="m-name" placeholder="Ej: John Doe" required>
                </div>
                <div class="input-group">
                    <label>Instrumento</label>
                    <input type="text" id="m-instrument" placeholder="Ej: Guitarra" required>
                </div>
                <div class="input-group">
                    <label>Rol</label>
                    <select id="m-role">
                        <option value="Músico">Músico</option>
                        <option value="Líder">Líder</option>
                        <option value="Técnico">Técnico</option>
                    </select>
                </div>
                <div class="input-group">
                    <label>Contacto (Email/Tel)</label>
                    <input type="text" id="m-contact" placeholder="Ej: john@band.com">
                </div>
                <button type="submit" class="btn-primary">Registrar Miembro</button>
            </form>
        </div>
    `;
    setActiveNav('nav-add');

    document.getElementById('member-form').onsubmit = async (e) => {
        e.preventDefault();
        const newMember = {
            id: Date.now().toString(),
            name: document.getElementById('m-name').value,
            instrument: document.getElementById('m-instrument').value,
            role: document.getElementById('m-role').value,
            contact: document.getElementById('m-contact').value,
            available: true,
            joined: new Date().toISOString()
        };

        await saveMember(newMember);
        state.members = [...state.members, newMember];
        state.view = 'list';
    };
};

const renderEditView = (container) => {
    const m = state.selectedMember;
    if (!m) { state.view = 'list'; return; }

    container.innerHTML = `
        <div class="animate-fade-in">
            <div class="header-with-action">
                <button onclick="state.view = 'list'" class="btn-icon-back">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                </button>
                <h1 style="font-weight: 800; font-size: 1.2rem; margin: 0; flex: 1; text-align: center;">DETALLES</h1>
                <button onclick="window.deleteMember('${m.id}')" class="btn-icon-delete">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
            </div>
            <form id="edit-form" class="form-container">
                <div class="input-group">
                    <label>Nombre Completo</label>
                    <input type="text" id="e-name" value="${m.name}" required>
                </div>
                <div class="input-group">
                    <label>Instrumento</label>
                    <input type="text" id="e-instrument" value="${m.instrument}" required>
                </div>
                <div class="input-group">
                    <label>Rol</label>
                    <select id="e-role">
                        <option value="Músico" ${m.role === 'Músico' ? 'selected' : ''}>Músico</option>
                        <option value="Líder" ${m.role === 'Líder' ? 'selected' : ''}>Líder</option>
                        <option value="Técnico" ${m.role === 'Técnico' ? 'selected' : ''}>Técnico</option>
                    </select>
                </div>
                <div class="input-group">
                    <label>Contacto (Email/Tel)</label>
                    <input type="text" id="e-contact" value="${m.contact || ''}">
                </div>
                <div class="form-actions">
                    <button type="button" onclick="state.view = 'list'" class="btn-secondary">Cancelar</button>
                    <button type="submit" class="btn-primary">Guardar Cambios</button>
                </div>
            </form>
        </div>
    `;

    document.getElementById('edit-form').onsubmit = async (e) => {
        e.preventDefault();
        const updatedMember = {
            ...m,
            name: document.getElementById('e-name').value,
            instrument: document.getElementById('e-instrument').value,
            role: document.getElementById('e-role').value,
            contact: document.getElementById('e-contact').value
        };

        await saveMember(updatedMember);
        state.members = state.members.map(mem => mem.id === m.id ? updatedMember : mem);
        state.view = 'list';
    };
};

const renderScoresView = (container) => {
    container.innerHTML = `
        <div class="animate-fade-in">
            <div class="scores-header">
                <h1>Partituras</h1>
                <label class="btn-primary score-upload-button" for="pdf-upload">Subir PDF</label>
                <input type="file" id="pdf-upload" accept="application/pdf" class="upload-input" />
            </div>

            <p id="upload-status" class="upload-status">${state.scoreMessage}</p>

            <div class="score-list">
                ${state.scores.length === 0 ? `
                    <div class="empty-state">
                        <p>No hay partituras guardadas.</p>
                        <label class="btn-secondary" for="pdf-upload-empty">Elegir PDF</label>
                        <input type="file" id="pdf-upload-empty" accept="application/pdf" class="upload-input" />
                    </div>
                ` : ''}

                ${state.scores.map(score => `
                    <div class="score-card">
                        <button class="score-open" onclick="window.openScore('${score.path}')">
                            <span class="score-icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path><path d="M9 18h4"></path></svg>
                            </span>
                            <span class="score-info">
                                <strong>${score.title}</strong>
                                <small>${score.fileName} · ${formatFileSize(score.size)}</small>
                            </span>
                        </button>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    setActiveNav('nav-scores');

    const onFileSelected = async (e) => {
        const file = e.target.files[0];
        const status = document.getElementById('upload-status');
        if (!file) return;

        if (file.type !== 'application/pdf') {
            status.textContent = 'Selecciona un archivo PDF.';
            e.target.value = '';
            return;
        }

        status.textContent = `Subiendo ${file.name}...`;

        try {
            const score = await uploadScore(file);
            state.scoreMessage = `Partitura subida a Supabase: ${file.name}`;
            state.scores = sortScores([score, ...state.scores.filter(item => item.path !== score.path)]);
        } catch (error) {
            console.error('No se pudo subir la partitura:', error);
            state.scoreMessage = `No se pudo subir a Supabase: ${error.message}`;
        } finally {
            e.target.value = '';
        }
    };

    document.getElementById('pdf-upload').onchange = onFileSelected;
    const emptyInput = document.getElementById('pdf-upload-empty');
    if (emptyInput) emptyInput.onchange = onFileSelected;
};

// --- SEED DATA ---
const seedData = async () => {
    const demoMembers = [
        { id: '1', name: 'Jimi Hendrix', instrument: 'Guitarra', role: 'Músico', contact: 'jimi@rock.com', available: true, joined: new Date().toISOString() },
        { id: '2', name: 'Freddie Mercury', instrument: 'Voz/Piano', role: 'Líder', contact: 'freddie@queen.com', available: true, joined: new Date().toISOString() },
        { id: '3', name: 'John Bonham', instrument: 'Batería', role: 'Músico', contact: 'bonzo@ledzep.com', available: true, joined: new Date().toISOString() },
        { id: '4', name: 'Brian Eno', instrument: 'Sintetizadores', role: 'Técnico', contact: 'eno@ambient.com', available: true, joined: new Date().toISOString() },
        { id: '5', name: 'Flea', instrument: 'Bajo', role: 'Músico', contact: 'flea@rhcp.com', available: true, joined: new Date().toISOString() }
    ];

    for (const member of demoMembers) {
        await saveMember(member);
    }
    state.members = await getAllMembers();
};
window.seedData = seedData;

// --- GLOBAL ACTIONS ---
window.editMember = (id) => {
    state.selectedMember = state.members.find(m => m.id === id);
    state.view = 'edit';
};

window.deleteMember = async (id) => {
    if (confirm('¿Estás seguro de que quieres eliminar a este miembro?')) {
        await deleteMemberFromDB(id);
        state.members = state.members.filter(m => m.id !== id);
        state.view = 'list';
    }
};

window.toggleAvailability = async (id) => {
    const index = state.members.findIndex(m => m.id === id);
    if (index !== -1) {
        const updatedMembers = [...state.members];
        updatedMembers[index].available = !updatedMembers[index].available;
        await saveMember(updatedMembers[index]);
        state.members = updatedMembers;
    }
};

window.openScore = async (path) => {
    if (!supabase) {
        state.scoreMessage = 'No se puede abrir: Supabase no está disponible.';
        return;
    }

    const { data, error } = await supabase.storage
        .from(SCORES_BUCKET)
        .createSignedUrl(path, 600);

    if (error || !data?.signedUrl) {
        state.scoreMessage = `No se pudo abrir desde Supabase: ${error?.message || 'error desconocido'}`;
        return;
    }

    window.open(data.signedUrl, '_blank');
};

// --- INITIALIZATION ---
const init = async () => {
    state.members = await getAllMembers();
    try {
        state.scores = await getAllScores();
    } catch (error) {
        console.error('No se pudieron cargar las partituras:', error);
        state.scoreMessage = `No se pudieron cargar las partituras de Supabase: ${error.message}`;
    }

    document.getElementById('nav-list').onclick = () => state.view = 'list';
    document.getElementById('nav-add').onclick = () => state.view = 'add';
    document.getElementById('nav-scores').onclick = () => state.view = 'scores';

    window.addEventListener('online', () => {
        state.isOnline = true;
        getAllMembers().then(m => state.members = m); // Resync on reconnect
        getAllScores()
            .then(scores => {
                state.scoreMessage = '';
                state.scores = scores;
            })
            .catch(error => {
                state.scoreMessage = `No se pudieron cargar las partituras de Supabase: ${error.message}`;
            });
    });
    window.addEventListener('offline', () => state.isOnline = false);

    render();
};

init();
