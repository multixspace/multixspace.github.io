// MULTIX Code - Bootstrap Environment
// v0.3 - Raw Registers, New Comments, No Extensions

// --- КОНФІГУРАЦІЯ RISC-V RV64I ---
const RISCV = {
    // Basic Opcodes
    OP: {
        LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67,
        BRANCH: 0x63, LOAD: 0x03, STORE: 0x23,
        IMM: 0x13, OP: 0x33, SYSTEM: 0x73
    },
    // Raw Registers Only (x0-x31)
    REGS: {}
};

// Генеруємо мапу x0..x31 + zero
for (let i = 0; i < 32; i++) {
    RISCV.REGS[`x${i}`] = i;
}
RISCV.REGS['zero'] = 0;

// --- BOOTSTRAP COMPILER (MSA) ---
class Assembler {
    constructor() {
        this.code = [];       
        this.labels = {};     
        this.constants = {};  
        this.currentAddr = 0; 
        this.origin = 0;      
        this.lines = [];      
    }

    compile(source) {
        this.reset();
        
        // 1. Попередня обробка: Видалення блокових коментарів ;- ... -;
        // Використовуємо regex з прапором 's' (dotAll), щоб захопити переноси рядків
        let cleanSource = source.replace(/;-(.|[\r\n])*?-;/g, '');

        // 2. Розбиття на рядки та чистка рядкових коментарів ;
        this.lines = cleanSource.split('\n')
            .map(l => {
                // Відрізаємо коментар починаючи з ;
                const commentIdx = l.indexOf(';');
                if (commentIdx !== -1) return l.substring(0, commentIdx).trim();
                return l.trim();
            })
            .filter(l => l); // Прибираємо пусті рядки
        
        log("Build started...", "sys");

        try {
            // Pass 1: Symbols
            this.pass1();
            log(`Pass 1: Symbols resolved (${Object.keys(this.labels).length} labels)`, "sys");

            // Pass 2: Generation
            this.pass2();
            log(`Pass 2: Code generated. Size: ${this.code.length} bytes.`, "success");
            
            return new Uint8Array(this.code);
        } catch (e) {
            log(`Build Error: ${e.message}`, "err");
            return null;
        }
    }

    reset() {
        this.code = [];
        this.labels = {};
        this.constants = {};
        this.currentAddr = 0;
        this.origin = 0;
    }

    // --- PASS 1 ---
    pass1() {
        let pc = 0; 
        
        for (let line of this.lines) {
            // Constants: #NAME = VALUE
            if (line.startsWith('#')) {
                const parts = line.split('=');
                const name = parts[0].trim().substring(1);
                const val = this.parseValue(parts[1].trim());
                this.constants[name] = val;
                continue;
            }

            // Origin: @ ADDR
            if (line.startsWith('@')) {
                const val = this.parseValue(line.substring(1).trim());
                this.origin = val;
                pc = val;
                continue;
            }

            // Labels
            // 1. Точка входу модуля (просто :)
            if (line === ':') {
                // Використовуємо спеціальне ім'я для дефолтної мітки, наприклад "__entry__"
                // Або якщо це імпорт модуля, зовнішній код буде посилатися на ім'я файлу.
                // Поки що зберігаємо як поточний pc.
                // TODO: Логіка прив'язки до імені файлу буде пізніше.
                this.labels[':'] = pc; 
                continue;
            }

            // 2. Іменовані мітки (Label:)
            if (line.endsWith(':')) {
                const label = line.slice(0, -1);
                this.labels[label] = pc;
                continue;
            }

            // Instructions sizing
            pc += 4; 
        }
    }

    // --- PASS 2 ---
    pass2() {
        let pc = this.origin;
        
        for (let line of this.lines) {
            // Skip declarations
            if (line.startsWith('#') || line.endsWith(':') || line === ':' || line.startsWith('@')) continue;

            // 1. Control Flow: = (Return)
            if (line === '=') {
                // JALR x0, 0(x1) -> Припускаємо, що x1 це RA (Return Address), 
                // АЛЕ ми домовились не фіксувати ролі. 
                // Для 'return' нам все одно треба знати, куди повертатися.
                // Поки що хардкодимо x1 як лінк-регістр для викликів.
                this.emitI(0x67, 0, 0, 1, 0); 
                pc += 4; continue;
            }

            // 2. Control Flow: ? (IF stub)
            if (line.startsWith('?')) {
                this.emit(0x13, 0, 0, 0, 0); // NOP
                pc += 4; continue;
            }
            // Block separators
            if (line.startsWith(':')) { // :? or : (else)
                this.emit(0x13, 0, 0, 0, 0); // NOP
                pc += 4; continue;
            }
            
            // 3. Assignment: dest = src
            if (line.includes('=')) {
                const parts = line.split('=');
                const destStr = parts[0].trim();
                const srcStr = parts[1].trim();
                
                // Store: [reg] = reg
                if (destStr.startsWith('[') && destStr.endsWith(']')) {
                    const rs1 = this.parseReg(destStr.slice(1, -1));
                    const rs2 = this.parseReg(srcStr);
                    // SD rs2, 0(rs1)
                    this.emitS(0x23, 3, rs1, rs2, 0);
                    pc += 4; continue;
                }

                const rd = this.parseReg(destStr);

                // Load: reg = [reg]
                if (srcStr.startsWith('[') && srcStr.endsWith(']')) {
                    const rs1 = this.parseReg(srcStr.slice(1, -1));
                    // LD rd, 0(rs1)
                    this.emitI(0x03, 3, rd, rs1, 0);
                    pc += 4; continue;
                }

                // Arithmetic: reg = reg + val/reg
                if (srcStr.includes('+')) {
                    const opParts = srcStr.split('+').map(s => s.trim());
                    const rs1 = this.parseReg(opParts[0]);
                    
                    if (this.isReg(opParts[1])) {
                        // ADD
                        const rs2 = this.parseReg(opParts[1]);
                        this.emitR(0x33, 0, 0, rd, rs1, rs2);
                    } else {
                        // ADDI
                        const imm = this.parseValue(opParts[1]);
                        this.emitI(0x13, 0, rd, rs1, imm);
                    }
                    pc += 4; continue;
                }

                // Move/Immediate
                if (this.isReg(srcStr)) {
                    // MV (ADDI rd, rs1, 0)
                    const rs1 = this.parseReg(srcStr);
                    this.emitI(0x13, 0, rd, rs1, 0);
                } else {
                    // LI (ADDI rd, zero, imm)
                    const imm = this.parseValue(srcStr);
                    this.emitI(0x13, 0, rd, 0, imm);
                }
                pc += 4; continue;
            }
            
            // 4. Function Call (Jump)
            // Якщо це просто ім'я мітки/модуля
            let targetLabel = line;
            if (this.labels[targetLabel] !== undefined) {
                const target = this.labels[targetLabel];
                const offset = target - pc;
                // JAL x1, offset (Використовуємо x1 як лінк-регістр за замовчуванням для викликів)
                this.emitJ(0x6F, 1, offset);
                pc += 4; continue;
            }
        }
    }

    // --- HELPERS ---
    parseReg(str) {
        if (RISCV.REGS[str] !== undefined) return RISCV.REGS[str];
        throw new Error(`Unknown register: ${str}`);
    }
    isReg(str) { return RISCV.REGS[str] !== undefined; }
    parseValue(str) {
        if (this.constants[str] !== undefined) return this.constants[str];
        if (this.labels[str] !== undefined) return this.labels[str];
        if (str.startsWith('0x')) return parseInt(str, 16);
        if (str.startsWith("'")) return str.charCodeAt(1);
        return parseInt(str);
    }

    // --- EMITTERS ---
    pushWord(word) {
        this.code.push(word & 0xFF);
        this.code.push((word >> 8) & 0xFF);
        this.code.push((word >> 16) & 0xFF);
        this.code.push((word >> 24) & 0xFF);
    }
    // R-Type
    emitR(opcode, funct3, funct7, rd, rs1, rs2) {
        this.pushWord((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    // I-Type
    emitI(opcode, funct3, rd, rs1, imm) {
        this.pushWord(((imm & 0xFFF) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    // S-Type
    emitS(opcode, funct3, rs1, rs2, imm) {
        const imm11_5 = (imm >> 5) & 0x7F;
        const imm4_0 = imm & 0x1F;
        this.pushWord((imm11_5 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (imm4_0 << 7) | opcode);
    }
    // J-Type
    emitJ(opcode, rd, imm) {
        const i20 = (imm >> 20) & 1;
        const i10_1 = (imm >> 1) & 0x3FF;
        const i11 = (imm >> 11) & 1;
        const i19_12 = (imm >> 12) & 0xFF;
        this.pushWord((i20 << 31) | (i10_1 << 21) | (i11 << 20) | (i19_12 << 12) | (rd << 7) | opcode);
    }
    emit(w) { this.pushWord(w); }
}

// --- APP UI ---
const State = {
    theme: 'light',
    activeView: 'files',
    files: {
        'boot': '; MULTIX System Assembly\n; Bootloader Entry\n\n#RAM = 0x80000000\n#UART = 0x10000000\n\n@ #RAM\n\n:\n    ; Init Stack (using x2 manualy)\n    x2 = #RAM\n    \n    ; Test UART\n    x5 = #UART\n    x6 = \'H\'\n    [x5] = x6\n    x6 = \'i\'\n    [x5] = x6\n    \n    kernel\n    =\n',
        'kernel': '; MULTIX System Assembly\n; Kernel Module\n\n:\n    ;\n    ='
    },
    currentFile: 'boot'
};

const UI = {
    editor: document.getElementById('code-editor'),
    lines: document.getElementById('line-numbers'),
    treeView: document.getElementById('tree-view'),
    console: document.getElementById('console-output'),
    navFiles: document.getElementById('nav-files'),
    navAI: document.getElementById('nav-ai'),
    navBuild: document.getElementById('nav-build'),
    navTheme: document.getElementById('nav-theme'),
    btnClear: document.getElementById('btn-clear-console')
};

const App = {
    compiler: new Assembler(),

    init: function() {
        App.renderTree();
        App.openFile(State.currentFile);
        
        UI.editor.addEventListener('input', App.updateLines);
        UI.editor.addEventListener('scroll', () => {
            UI.lines.scrollTop = UI.editor.scrollTop;
        });

        UI.navFiles.addEventListener('click', () => App.switchSidebar('files'));
        UI.navAI.addEventListener('click', () => App.switchSidebar('ai'));
        UI.navTheme.addEventListener('click', App.toggleTheme);
        UI.navBuild.addEventListener('click', App.build);
        UI.btnClear.addEventListener('click', () => UI.console.innerHTML = '');

        log("MULTIX Dev Environment Ready.", "sys");
    },

    openFile: function(name) {
        State.currentFile = name;
        UI.editor.value = State.files[name];
        App.updateLines();
        document.querySelectorAll('.list-item').forEach(el => {
            el.classList.remove('active');
            if (el.dataset.name === name) el.classList.add('active');
        });
    },

    renderTree: function() {
        UI.treeView.innerHTML = '';
        Object.keys(State.files).forEach(name => {
            const div = document.createElement('div');
            div.className = 'list-item';
            div.dataset.name = name;
            div.innerHTML = `<span class="file-icon">📄</span> ${name}`;
            div.onclick = () => App.openFile(name);
            UI.treeView.appendChild(div);
        });
    },

    switchSidebar: function(view) {
        const aiView = document.getElementById('ai-interface');
        const chatList = document.getElementById('chat-list-view');
        if (view === 'files') {
            UI.navFiles.classList.add('active');
            UI.navAI.classList.remove('active');
            UI.treeView.classList.remove('hidden');
            chatList.classList.add('hidden');
            document.getElementById('panel-title').textContent = "EXPLORER";
            aiView.classList.add('hidden');
            document.getElementById('editor-wrapper').classList.remove('hidden');
        } else {
            UI.navFiles.classList.remove('active');
            UI.navAI.classList.add('active');
            UI.treeView.classList.add('hidden');
            chatList.classList.remove('hidden');
            document.getElementById('panel-title').textContent = "AI ARCHITECT";
            aiView.classList.remove('hidden');
        }
    },

    toggleTheme: function() {
        const body = document.body;
        const current = body.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        body.setAttribute('data-theme', next);
    },

    updateLines: function() {
        const count = UI.editor.value.split('\n').length;
        UI.lines.innerHTML = Array(count).fill(0).map((_, i) => i + 1).join('<br>');
    },

    build: function() {
        State.files[State.currentFile] = UI.editor.value;
        const bin = App.compiler.compile(UI.editor.value);
        if (bin) {
            let hex = "";
            for(let i=0; i<bin.length; i++) {
                hex += bin[i].toString(16).padStart(2, '0').toUpperCase() + " ";
                if ((i+1) % 16 === 0) hex += "\n";
            }
            log("Binary Output (Hex):", "sys");
            log(hex);
        }
    }
};

function log(msg, type="") {
    const time = new Date().toLocaleTimeString();
    const cls = type ? `log-${type}` : '';
    const html = `<div><span class="log-time">[${time}]</span><span class="${cls}">${msg}</span></div>`;
    UI.console.insertAdjacentHTML('beforeend', html);
    UI.console.scrollTop = UI.console.scrollHeight;
}

document.addEventListener('DOMContentLoaded', App.init);
