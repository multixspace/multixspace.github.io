// MULTIX Code - Bootstrap Environment
// v0.4 - Clean Syntax (# NAME, usage without #)

// --- КОНФІГУРАЦІЯ RISC-V RV64I ---
const RISCV = {
    OP: {
        LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67,
        BRANCH: 0x63, LOAD: 0x03, STORE: 0x23,
        IMM: 0x13, OP: 0x33, SYSTEM: 0x73
    },
    REGS: {}
};

// Map x0..x31
for (let i = 0; i < 32; i++) RISCV.REGS[`x${i}`] = i;

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
        
        // Pre-process: Clean block comments
        let cleanSource = source.replace(/;-(.|[\r\n])*?-;/g, '');

        // Split and clean line comments
        this.lines = cleanSource.split('\n')
            .map(l => {
                const commentIdx = l.indexOf(';');
                if (commentIdx !== -1) return l.substring(0, commentIdx).trim();
                return l.trim();
            })
            .filter(l => l);
        
        log("Build started...", "sys");

        try {
            this.pass1();
            log(`Pass 1: Symbols resolved (${Object.keys(this.labels).length} labels, ${Object.keys(this.constants).length} consts)`, "sys");

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

    // --- PASS 1: Symbol Discovery ---
    pass1() {
        let pc = 0; 
        
        for (let line of this.lines) {
            // 1. Constants: # NAME = VALUE
            if (line.startsWith('#')) {
                // Remove '#' then split by '='
                const content = line.substring(1); 
                const parts = content.split('=');
                
                if (parts.length !== 2) throw new Error(`Invalid constant decl: ${line}`);

                const name = parts[0].trim();
                const valStr = parts[1].trim();
                const val = this.parseValue(valStr); // Recursive resolution possible? For now simple.
                
                this.constants[name] = val;
                continue;
            }

            // 2. Origin: @ ADDR (ADDR can be a constant name now!)
            if (line.startsWith('@')) {
                const valStr = line.substring(1).trim();
                const val = this.parseValue(valStr); // Resolve name -> value
                this.origin = val;
                pc = val;
                continue;
            }

            // 3. Labels
            if (line === ':') {
                this.labels[':'] = pc; 
                continue;
            }
            if (line.endsWith(':')) {
                const label = line.slice(0, -1);
                this.labels[label] = pc;
                continue;
            }

            // Instructions sizing
            pc += 4; 
        }
    }

    // --- PASS 2: Code Generation ---
    pass2() {
        let pc = this.origin;
        
        for (let line of this.lines) {
            if (line.startsWith('#') || line.endsWith(':') || line === ':' || line.startsWith('@')) continue;

            // 1. Control Flow: = (Return)
            if (line === '=') {
                this.emitI(0x67, 0, 0, 1, 0); // JALR x0, 0(x1)
                pc += 4; continue;
            }

            // 2. Control Flow: Stub ? and :
            if (line.startsWith('?') || line.startsWith(':')) {
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
                    this.emitS(0x23, 3, rs1, rs2, 0);
                    pc += 4; continue;
                }

                const rd = this.parseReg(destStr);

                // Load: reg = [reg]
                if (srcStr.startsWith('[') && srcStr.endsWith(']')) {
                    const content = srcStr.slice(1, -1);
                    // Check for [reg + offset]
                    if (content.includes('+')) {
                         const mParts = content.split('+');
                         const rs1 = this.parseReg(mParts[0].trim());
                         const off = this.parseValue(mParts[1].trim());
                         this.emitI(0x03, 3, rd, rs1, off);
                    } else {
                         const rs1 = this.parseReg(content);
                         this.emitI(0x03, 3, rd, rs1, 0);
                    }
                    pc += 4; continue;
                }

                // Arithmetic: reg = reg + val/reg
                if (srcStr.includes('+')) {
                    const opParts = srcStr.split('+').map(s => s.trim());
                    const rs1 = this.parseReg(opParts[0]);
                    
                    if (this.isReg(opParts[1])) {
                        const rs2 = this.parseReg(opParts[1]);
                        this.emitR(0x33, 0, 0, rd, rs1, rs2);
                    } else {
                        const imm = this.parseValue(opParts[1]);
                        this.emitI(0x13, 0, rd, rs1, imm);
                    }
                    pc += 4; continue;
                }

                // Move/Immediate
                if (this.isReg(srcStr)) {
                    const rs1 = this.parseReg(srcStr);
                    this.emitI(0x13, 0, rd, rs1, 0);
                } else {
                    const imm = this.parseValue(srcStr);
                    this.emitI(0x13, 0, rd, 0, imm);
                }
                pc += 4; continue;
            }
            
            // 4. Function Call (Label)
            let targetLabel = line;
            if (this.labels[targetLabel] !== undefined) {
                const target = this.labels[targetLabel];
                const offset = target - pc;
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
        // 1. Check Constants
        if (this.constants[str] !== undefined) return this.constants[str];
        // 2. Check Labels
        if (this.labels[str] !== undefined) return this.labels[str];
        // 3. Hex
        if (str.startsWith('0x')) return parseInt(str, 16);
        // 4. Char
        if (str.startsWith("'")) return str.charCodeAt(1);
        // 5. Decimal
        const val = parseInt(str);
        if (!isNaN(val)) return val;

        // If used in Pass 1 for @ CONST, label might not exist yet, 
        // but constant MUST exist.
        return 0; // Return 0 for unresolved labels in Pass 1 (resolved in Pass 2)
    }

    // --- EMITTERS ---
    pushWord(word) {
        this.code.push(word & 0xFF);
        this.code.push((word >> 8) & 0xFF);
        this.code.push((word >> 16) & 0xFF);
        this.code.push((word >> 24) & 0xFF);
    }
    emitR(opcode, funct3, funct7, rd, rs1, rs2) {
        this.pushWord((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    emitI(opcode, funct3, rd, rs1, imm) {
        this.pushWord(((imm & 0xFFF) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    emitS(opcode, funct3, rs1, rs2, imm) {
        const imm11_5 = (imm >> 5) & 0x7F;
        const imm4_0 = imm & 0x1F;
        this.pushWord((imm11_5 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (imm4_0 << 7) | opcode);
    }
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
        'boot': '; MULTIX System Assembly\n; Clean Syntax Demo\n\n# RAM = 0x80000000\n# UART = 0x10000000\n\n@ RAM\n\n:\n    ; No prefix needed for constants!\n    x2 = RAM + 0x1000\n    \n    x5 = UART\n    x6 = \'!\'\n    [x5] = x6\n    \n    =\n'
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
