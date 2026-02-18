// MULTIX Code - Bootstrap Environment
// v0.2 - With MSA Compiler and Console

// --- КОНФІГУРАЦІЯ RISC-V RV64I ---
const RISCV = {
    // Basic Opcodes
    OP: {
        LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67,
        BRANCH: 0x63, LOAD: 0x03, STORE: 0x23,
        IMM: 0x13, OP: 0x33, SYSTEM: 0x73
    },
    // Register Map
    REGS: {
        'x0': 0, 'zero': 0, 'ra': 1, 'sp': 2, 'gp': 3, 'tp': 4,
        't0': 5, 't1': 6, 't2': 7, 's0': 8, 'fp': 8, 's1': 9,
        'a0': 10, 'a1': 11, 'a2': 12, 'a3': 13, 'a4': 14, 'a5': 15,
        'a6': 16, 'a7': 17, 's2': 18, 's3': 19, 's4': 20, 's5': 21,
        's6': 22, 's7': 23, 's8': 24, 's9': 25, 's10': 26, 's11': 27,
        't3': 28, 't4': 29, 't5': 30, 't6': 31
    }
};

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
        // Груба очистка
        this.lines = source.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('//'));
        
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
        let pc = 0; // Relative PC
        
        for (let line of this.lines) {
            if (line.includes('//')) line = line.split('//')[0].trim();
            if (!line) continue;

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

            // Labels: Label: or :
            if (line.endsWith(':')) {
                const label = line.slice(0, -1);
                if (label !== '') this.labels[label] = pc;
                continue;
            }

            // Instructions sizing (Simplified: 4 bytes each)
            // Loops/Conditions (?, :, =) also take space
            pc += 4; 
        }
    }

    // --- PASS 2 ---
    pass2() {
        let pc = this.origin;
        
        for (let line of this.lines) {
            if (line.includes('//')) line = line.split('//')[0].trim();
            if (!line) continue;
            
            // Skip declarations
            if (line.startsWith('#') || line.endsWith(':') || line.startsWith('@')) continue;

            // 1. Control Flow: = (Return)
            if (line === '=') {
                // JALR x0, 0(ra) -> RET
                this.emitI(0x67, 0, 0, 1, 0); 
                pc += 4; continue;
            }

            // 2. Control Flow: ? (IF stub)
            if (line.startsWith('?')) {
                this.emit(0x13, 0, 0, 0, 0); // NOP for now
                pc += 4; continue;
            }
            if (line.startsWith(':')) {
                this.emit(0x13, 0, 0, 0, 0); // NOP for now
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
                    // LI (ADDI rd, zero, imm) - Valid for small numbers
                    const imm = this.parseValue(srcStr);
                    this.emitI(0x13, 0, rd, 0, imm);
                }
                pc += 4; continue;
            }
            
            // 4. Function Call: Module.Func (Jump)
            if (this.labels[line] !== undefined) {
                const target = this.labels[line];
                const offset = target - pc;
                // JAL ra, offset
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
    // Fallback
    emit(w) { this.pushWord(w); }
}

// --- APP UI ---
const State = {
    theme: 'light',
    activeView: 'files',
    files: {
        'boot.msa': '// MULTIX System Assembly\n// Boot Test\n\n#UART = 0x10000000\n\n_start:\n    t0 = #UART\n    t1 = \'O\'\n    [t0] = t1\n    t1 = \'K\'\n    [t0] = t1\n    =\n',
        'kernel': '// Kernel Placeholder\n_main:\n    ='
    },
    currentFile: 'boot.msa'
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

        // Event Listeners
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
        // Highlight active
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
        // Save current file content
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
