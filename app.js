const State = {
    theme: 'light',
    activeView: 'files', // 'files' or 'ai'
    currentFile: 'main.asm',
    // Віртуальна файлова система
    files: {
        'main.asm': '; MULTIX Kernel Entry\n\n_start:\n    LUI x10, 0x40000\n    LB x11, 0(x10)\n    ADDI x11, x11, 1',
        'lib.asm': '; Standard Library\n\nfunc_math:\n    RET',
        'config.recipe': '// System Configuration\nnetwork: true',
        'notes.txt': 'To do: Implement UDP stack'
    }
};

const UI = {
    editor: document.getElementById('code-editor'),
    treeView: document.getElementById('tree-view'),
    chatView: document.getElementById('chat-list-view'),
    panelTitle: document.getElementById('panel-title'),
    navFiles: document.getElementById('nav-files'),
    navAI: document.getElementById('nav-ai'),
    navTheme: document.getElementById('nav-theme'),
    contextTabs: document.getElementById('context-tabs'),
    aiInterface: document.getElementById('ai-interface')
};

function init() {
    renderFileTree();
    openFile(State.currentFile); // Відкриваємо останній файл при старті
    
    // Навігація
    UI.navFiles.addEventListener('click', () => switchSidebar('files'));
    UI.navAI.addEventListener('click', () => switchSidebar('ai'));
    UI.navTheme.addEventListener('click', toggleTheme);

    // Кнопка в сайдбарі для з'єднання (D - Debug)
    document.getElementById('btn-debug').addEventListener('click', connectDevice);
    
    // Перевірка підтримки WebUSB
    if (!navigator.usb) {
        console.log("WebUSB not supported in this browser. Use Chrome/Edge.");
    }
}

// 1. Логіка "Без вкладок"
function openFile(filename) {
    State.currentFile = filename;
    
    // Просто замінюємо вміст редактора. Ніяких нових вікон.
    UI.editor.value = State.files[filename];
    
    // Оновлюємо виділення в дереві (Visual Feedback)
    document.querySelectorAll('.list-item').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.name === filename) el.classList.add('active');
    });

    // Переконуємось, що редактор видимий
    UI.editor.classList.remove('hidden');
    UI.aiInterface.classList.add('hidden');
}

// 2. Рендер дерева файлів
function renderFileTree() {
    UI.treeView.innerHTML = '';
    Object.keys(State.files).forEach(filename => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.dataset.name = filename;
        // Проста іконка файлу (текстова)
        div.innerHTML = `<span class="file-icon">📄</span> ${filename}`;
        
        div.onclick = () => openFile(filename);
        UI.treeView.appendChild(div);
    });
}

// 3. Перемикання Sidebar (Files <-> AI)
function switchSidebar(view) {
    State.activeView = view;
    
    if (view === 'files') {
        UI.navFiles.classList.add('active');
        UI.navAI.classList.remove('active');
        UI.treeView.classList.remove('hidden');
        UI.chatView.classList.add('hidden');
        UI.panelTitle.textContent = "EXPLORER";
        
        // Повертаємо редактор коду
        UI.editor.classList.remove('hidden');
        UI.aiInterface.classList.add('hidden');
        
    } else {
        UI.navFiles.classList.remove('active');
        UI.navAI.classList.add('active');
        UI.treeView.classList.add('hidden');
        UI.chatView.classList.remove('hidden');
        UI.panelTitle.textContent = "AI ARCHITECT";
        
        // Відкриваємо інтерфейс чату на місці редактора
        UI.editor.classList.add('hidden');
        UI.aiInterface.classList.remove('hidden');
    }
}

// 4. Тема
function toggleTheme() {
    const body = document.body;
    const current = body.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    body.setAttribute('data-theme', next);
}

// 5. Демонстрація "Контекстних Вкладок" (Simulation)
// Це функція, яку викличе ШІ, коли запропонує переглянути зміни
function showContextTabs(filesArray) {
    UI.contextTabs.classList.remove('hidden');
    UI.contextTabs.innerHTML = '';
    
    filesArray.forEach(file => {
        const tab = document.createElement('div');
        tab.className = 'tab';
        if(file === State.currentFile) tab.classList.add('active');
        tab.textContent = file;
        tab.onclick = () => openFile(file);
        UI.contextTabs.appendChild(tab);
    });
}

let device = null;

async function connectDevice() {
    try {
        console.log("Searching for Milk-V Jupiter...");
        
        // Ми поки не знаємо точний VID SpacemiT, тому просимо показати ВСІ пристрої.
        // Коли дізнаємось VID, впишемо сюди: { vendorId: 0xXXXX }
        device = await navigator.usb.requestDevice({ filters: [] });
        
        await device.open();
        
        // Виводимо інформацію про знахідку
        const info = `Connected: ${device.productName || 'Unknown Device'} 
                      (VID: 0x${device.vendorId.toString(16)}, PID: 0x${device.productId.toString(16)})`;
        console.log(info);
        
        if (device.configuration === null) {
            await device.selectConfiguration(1);
        }
        
        await device.claimInterface(0);
        console.log("Interface claimed. Ready to talk to K1 Mask ROM.", "sys");
        
        // Оновлюємо статус в UI
        //document.getElementById('status-indicator').classList.add('connected');
        //document.getElementById('status-indicator').title = "Milk-V Jupiter Connected";

    } catch (err) {
        console.log(`Connection failed: ${err.message}`);
    }
}

document.addEventListener('DOMContentLoaded', init);
