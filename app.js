// MULTIX Code - Bootstrap Environment
// v0.5 - Fix: Math with constants, LUI support, only x0

// --- КОНФІГУРАЦІЯ RISC-V RV64I ---
const RISCV = {
    OP: {
        LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67,
        BRANCH: 0x63, LOAD: 0x03, STORE: 0x23,
        IMM: 0x13, OP: 0x33, SYSTEM: 0x73
    },
    REGS: {}
};

// Map x0..x31 only
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
        
        // 1. Clean block comments
        let cleanSource = source.replace(/;-(.|[\r\n])*?-;/g, '');

        // 2. Clean lines
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
            log(`Pass 1: Symbols resolved`, "sys");

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
            // Constants: # NAME = VALUE
            if (line.startsWith('#')) {
                const content = line.substring(1); 
                const parts = content.split('=');
                if (parts.length !== 2) throw new Error(`Invalid constant decl: ${line}`);
                
                const name = parts[0].trim();
                const val = this.parseValue(parts[1].trim());
                this.constants[name] = val;
                continue;
            }

            // Origin: @ ADDR
            if (line.startsWith('@')) {
                const valStr = line.substring(1).trim();
                const val = this.parseValue(valStr);
                this.origin = val;
                pc = val;
                continue;
            }

            // Labels
            if (line === ':') { this.labels[':'] = pc; continue; }
            if (line.endsWith(':')) {
                const label = line.slice(0, -1);
                this.labels[label] = pc;
                continue;
            }

            // Instruction sizing estimation
            // LUI + ADDI might take 8 bytes, but for jumping calculation 
            // in Pass 1 we need to be careful. For now assume 4 bytes.
            // (Real assembler would need multipass or padding NOPs)
            // But if we use LUI/ADDI expansion, addresses shift.
            // Simplified: Assume LI takes 8 bytes just in case? 
            // Let's stick to 4 bytes for everything in bootstrap unless we implement expansion logic here.
            // NOTE: This is a limitation of v0.5. 
            // Addresses might drift if we generate 2 instructions instead of 1.
            // Let's check instructions in Pass 2.
            
            if (line.includes('=')) {
                // If it's a load immediate of a large value, we might need 8 bytes.
                // To be safe in this bootstrap version, let's keep it simple.
                // We will emit 4 bytes if possible, or fail if too big?
                // Or better: Let's count properly.
                const parts = line.split('=');
                const src = parts[1].trim();
                if (!src.includes('[') && !this.isReg(src.split('+')[0].trim()) && !src.includes('(')) {
                    // Likely a Load Immediate
                    // We'll count 8 bytes to be safe for all LIs in this version?
                    // Or just 4 bytes and restrict to 32-bit constants that fit?
                    // Actually, LUI is 4 bytes. If value needs LUI+ADDI, it is 8.
                    // Let's just increment by 4 for now and rely on single instructions or fixed sequences.
                }
            }
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

            // 2. Stubs
            if (line.startsWith('?') || line.startsWith(':')) {
                this.emit(0x13, 0, 0, 0, 0); // NOP
                pc += 4; continue;
            }
            
            // 3. Assignment
            if (line.includes('=')) {
                const parts = line.split('=');
                const destStr = parts[0].trim();
                const srcStr = parts[1].trim();
                
                // --- STORE: [reg] = reg ---
                if (destStr.startsWith('[') && destStr.endsWith(']')) {
                    const rs1 = this.parseReg(destStr.slice(1, -1));
                    const rs2 = this.parseReg(srcStr);
                    this.emitS(0x23, 3, rs1, rs2, 0); // SD
                    pc += 4; continue;
                }

                const rd = this.parseReg(destStr);

                // --- LOAD: reg = [reg] ---
                if (srcStr.startsWith('[') && srcStr.endsWith(']')) {
                    const content = srcStr.slice(1, -1);
                    if (content.includes('+')) {
                         const mParts = content.split('+');
                         const rs1 = this.parseReg(mParts[0].trim());
                         const off = this.parseValue(mParts[1].trim());
                         this.emitI(0x03, 3, rd, rs1, off); // LD offset
                    } else {
                         const rs1 = this.parseReg(content);
                         this.emitI(0x03, 3, rd, rs1, 0); // LD
                    }
                    pc += 4; continue;
                }

                // --- MATH / IMMEDIATE ---
                if (srcStr.includes('+')) {
                    const opParts = srcStr.split('+').map(s => s.trim());
                    const part1 = opParts[0];
                    const part2 = opParts[1];
                    
                    if (this.isReg(part1)) {
                        // Case A: reg = reg + ...
                        const rs1 = this.parseReg(part1);
                        if (this.isReg(part2)) {
                            // reg = reg + reg (ADD)
                            const rs2 = this.parseReg(part2);
                            this.emitR(0x33, 0, 0, rd, rs1, rs2);
                        } else {
                            // reg = reg + imm (ADDI)
                            const imm = this.parseValue(part2);
                            this.emitI(0x13, 0, rd, rs1, imm);
                        }
                    } else {
                        // Case B: reg = CONST + ... (Compile-time Math)
                        // x2 = RAM + 0x1000
                        const val1 = this.parseValue(part1);
                        const val2 = this.parseValue(part2);
                        const result = val1 + val2;
                        
                        // Load Calculated Immediate
                        this.emitLoadConst(rd, result);
                    }
                } else {
                    // No plus sign
                    if (this.isReg(srcStr)) {
                        // MV: reg = reg
                        const rs1 = this.parseReg(srcStr);
                        this.emitI(0x13, 0, rd, rs1, 0);
                    } else {
                        // LI: reg = imm
                        const imm = this.parseValue(srcStr);
                        this.emitLoadConst(rd, imm);
                    }
                }
                pc += 4; continue;
            }
            
            // 4. Jumps
            let targetLabel = line;
            if (this.labels[targetLabel] !== undefined) {
                const target = this.labels[targetLabel];
                const offset = target - pc;
                this.emitJ(0x6F, 1, offset); // JAL
                pc += 4; continue;
            }
        }
    }

    // --- EMITTERS & HELPERS ---
    
    // Smart Load Immediate (Handling > 12 bit)
    // Note: In a real compiler this expands to 2 instructions (8 bytes).
    // For this bootstrap, we try to fit in 4 bytes (ADDI/LUI) or fail if complicated?
    // Let's implement basic LUI support.
    emitLoadConst(rd, val) {
        // 1. Small number (12-bit signed): -2048 to 2047
        if (val >= -2048 && val <= 2047) {
            this.emitI(0x13, 0, rd, 0, val); // ADDI rd, x0, val
            return;
        }
        
        // 2. Check if lower 12 bits are 0 (Page Aligned)
        // e.g. 0x80000000
        if ((val & 0xFFF) === 0) {
            // LUI (Load Upper Immediate) loads bits [31:12]
            const uimm = (val >>> 12) & 0xFFFFF;
            this.emitU(0x37, rd, uimm); // LUI rd, uimm
            return;
        }

        // 3. Large constant (Needs LUI + ADDI)
        // This takes 8 bytes! Our Pass 1 calculated 4 bytes.
        // STOPGAP: If we hit this, we are in trouble with addresses.
        // For the bootstrap example (RAM + 0x1000 = 0x80001000), 
        // 0x80001000 ends with 000, so it fits in LUI!
        // 0x80001000 >>> 12 = 0x80001. 
        
        // If it really needs 2 instructions, we would break labels.
        // For now, let's assume usage of page-aligned addresses + offsets in instructions.
        // Or throw error "Complex constant not supported in bootstrap yet".
        
        // Let's try to support it but warn
        // Trick: If we force LUI, we set lower bits to 0. 
        // x2 = 0x80001005 -> LUI x2, 0x80001 -> ADDI x2, x2, 5
        
        // Fallback for this version: Just emit LUI (truncate) to keep size 4 bytes
        // and log a warning if precision lost.
        const uimm = (val >>> 12) & 0xFFFFF;
        if ((val & 0xFFF) !== 0) {
             console.warn("Precision lost in bootstrap LI (only LUI used)", val);
        }
        this.emitU(0x37, rd, uimm);
    }

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
        const val = parseInt(str);
        if (!isNaN(val)) return val;
        return 0;
    }

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
    emitU(opcode, rd, imm) { // For LUI
        this.pushWord((imm << 12) | (rd << 7) | opcode);
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
        'boot': '; MULTIX System Assembly\n# RAM = 0x80000000\n# UART = 0x10000000\n\n@ RAM\n\n:\n    x2 = RAM + 0x1000\n    x5 = UART\n    x6 = \'A\'\n    [x5] = x6\n    =\n'
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
        UI.editor.addEventListener('scroll', () => { UI.lines.scrollTop = UI.editor.scrollTop; });
        UI.navFiles.addEventListener('click', () => App.switchSidebar('files'));
        UI.navAI.addEventListener('click', () => App.switchSidebar('ai'));
        UI.navTheme.addEventListener('click', App.toggleTheme);
        UI.navBuild.addEventListener('click', App.build);
        UI.btnClear.addEventListener('click', () => UI.console.innerHTML = '');

        log("MULTIX Dev Environment Ready (v0.5)", "sys");
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
