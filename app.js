// MULTIX Code - Bootstrap Environment
// v0.9 - Bare Metal Minimalism ([], No =, Pre/Post Increment)

const RISCV = {
    OP: { LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67, BRANCH: 0x63, LOAD: 0x03, STORE: 0x23, IMM: 0x13, OP: 0x33, SYSTEM: 0x73 },
    REGS: {}
};
for (let i = 0; i < 32; i++) RISCV.REGS[`x${i}`] = i;

class Assembler {
    constructor() { this.reset(); }

    compile(source) {
        this.reset();
        let cleanSource = source.replace(/;-(.|[\r\n])*?-;/g, '');
        let rawLines = cleanSource.split('\n');
        for (let l of rawLines) {
            const commentIdx = l.indexOf(';');
            let text = commentIdx !== -1 ? l.substring(0, commentIdx) : l;
            if (text.trim() === '') continue;
            this.lines.push({ text: text.trim(), indent: text.search(/\S|$/) });
        }
        
        log("Build started (v0.9)...", "sys");
        try {
            this.pass1(); this.pass2();
            log(`Build Success. Size: ${this.code.length} bytes.`, "success");
            log("--- INTERMEDIATE RISC-V ASM ---", "sys");
            for (let t of this.asmTrace) log(t);
            return new Uint8Array(this.code);
        } catch (e) {
            log(`Build Error: ${e.message}`, "err"); return null;
        }
    }

    reset() {
        this.code = []; this.labels = {}; this.constants = {}; 
        this.origin = 0; this.lines = []; this.asmTrace = [];
    }

    // --- PASS 1: Symbols & Sizes ---
    pass1() {
        let pc = 0; 
        let inCode = false;

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text;
            let tokens = line.split(/\s+/);

            if (line.startsWith(':')) {
                inCode = true;
                const valStr = tokens[1];
                if (valStr) { const val = this.parseValue(valStr); this.origin = val; pc = val; }
                this.labels[':'] = pc; continue;
            }
            if (line.endsWith(':')) { 
                inCode = true;
                this.labels[line.slice(0, -1)] = pc; continue; 
            }

            // Constants (Before first label)
            if (!inCode) {
                this.constants[tokens[0]] = this.parseValue(tokens[1]);
                continue;
            }

            let t0 = tokens[0];

            // Halt
            if (t0 === '_') { pc += 4; continue; }

            // Return / Jump: = [x31++]
            if (t0 === '=') { pc += 12; continue; }

            // Call: Label [--x31]
            if (tokens.length >= 2 && tokens[1].startsWith('[--')) {
                pc += 20; continue;
            }

            // Store: [--x31] val OR [addr] val
            if (t0.startsWith('[')) {
                if (t0.startsWith('[--')) pc += 8; // Pre-dec + SD
                else pc += 4; // Normal SD
                continue;
            }

            // Assignment / Load: reg val OR reg [x31++] OR reg math
            if (this.isReg(t0)) {
                if (tokens[1].startsWith('[')) {
                    if (tokens[1].includes('++')) pc += 8; // LD + Post-inc
                    else pc += 4; // Normal LD
                } else if (tokens.length > 2 && ['+','-','|','&','^'].includes(tokens[2])) {
                    pc += 4; // Math
                } else {
                    pc += 4; // Immediate/Move
                }
                continue;
            }

            // Fallback for simple Jump
            if (this.labels[t0] !== undefined || t0.match(/^[a-zA-Z_]\w*$/)) { pc += 4; continue; } 
        }
    }

    // --- PASS 2: Code Generation ---
    pass2() {
        let pc = this.origin; 
        let inCode = false;

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text;
            let tokens = line.split(/\s+/);

            if (line.startsWith(':') || line.endsWith(':')) {
                inCode = true;
                if (line.startsWith(':')) this.emitTrace(`\n; ${line} (Origin: 0x${pc.toString(16)})`);
                continue;
            }

            if (!inCode) continue; // Skip constants in Pass 2

            this.emitTrace(`\n; ${line}`);
            let t0 = tokens[0];

            // 1. Halt
            if (t0 === '_') {
                this.emitJ(0x6F, 0, 0, `JAL x0, 0 (Halt)`); pc += 4; continue;
            }

            // 2. Return (Jump): = [x31++]
            if (t0 === '=') {
                let memToken = tokens[1]; // [x31++]
                if (memToken.includes('++')) {
                    let reg = this.parseReg(memToken.replace(/[\[\]\+]/g, ''));
                    this.emitI(0x03, 3, 1, reg, 0, `LD x1, 0(x${reg})`);
                    this.emitI(0x13, 0, reg, reg, 8, `ADDI x${reg}, x${reg}, 8`);
                    this.emitI(0x67, 0, 0, 1, 0, `JALR x0, 0(x1)`); 
                    pc += 12; continue;
                }
            }

            // 3. Call: Label [--x31]
            if (tokens.length >= 2 && tokens[1].startsWith('[--')) {
                let target = t0;
                let regStr = tokens[1].replace(/[\[\]\-]/g, '');
                let reg = this.parseReg(regStr);
                
                this.emitU(0x17, 1, 0, `AUIPC x1, 0`); 
                this.emitI(0x13, 0, 1, 1, 20, `ADDI x1, x1, 20`); // +20 бо 5 інструкцій
                this.emitI(0x13, 0, reg, reg, -8, `ADDI x${reg}, x${reg}, -8`); 
                this.emitS(0x23, 3, reg, 1, 0, `SD x1, 0(x${reg})`); 
                
                let offset = this.labels[target] - pc - 16; // Враховуємо зсув PC
                this.emitJ(0x6F, 0, offset, `JAL x0, ${target} (${offset})`); 
                pc += 20; continue;
            }

            // 4. Store: [dest] src
            if (t0.startsWith('[')) {
                let srcReg = this.parseReg(tokens[1]);
                if (t0.startsWith('[--')) { // [--x31]
                    let reg = this.parseReg(t0.replace(/[\[\]\-]/g, ''));
                    this.emitI(0x13, 0, reg, reg, -8, `ADDI x${reg}, x${reg}, -8`);
                    this.emitS(0x23, 3, reg, srcReg, 0, `SD x${srcReg}, 0(x${reg})`);
                    pc += 8; continue;
                } else { // [x1]
                    let reg = this.parseReg(t0.replace(/[\[\]]/g, ''));
                    this.emitS(0x23, 3, reg, srcReg, 0, `SD x${srcReg}, 0(x${reg})`);
                    pc += 4; continue;
                }
            }

            // 5. Assignment/Load: reg ...
            if (this.isReg(t0)) {
                let rd = this.parseReg(t0);
                let t1 = tokens[1];

                // Load: x1 [x31++]
                if (t1.startsWith('[')) {
                    if (t1.includes('++')) {
                        let reg = this.parseReg(t1.replace(/[\[\]\+]/g, ''));
                        this.emitI(0x03, 3, rd, reg, 0, `LD x${rd}, 0(x${reg})`);
                        this.emitI(0x13, 0, reg, reg, 8, `ADDI x${reg}, x${reg}, 8`);
                        pc += 8; continue;
                    } else {
                        let reg = this.parseReg(t1.replace(/[\[\]]/g, ''));
                        this.emitI(0x03, 3, rd, reg, 0, `LD x${rd}, 0(x${reg})`);
                        pc += 4; continue;
                    }
                }

                // Math: x5 x5 + 1
                if (tokens.length > 2 && ['+','-','|','&','^'].includes(tokens[2])) {
                    let op = tokens[2];
                    if (this.isReg(t1)) {
                        let rs1 = this.parseReg(t1);
                        if (this.isReg(tokens[3])) {
                            this.emitR(0x33, 0, 0, rd, rs1, this.parseReg(tokens[3]), `ADD x${rd}, x${rs1}, x${this.parseReg(tokens[3])}`);
                        } else {
                            let imm = this.parseValue(tokens[3]);
                            this.emitI(0x13, 0, rd, rs1, imm, `ADDI x${rd}, x${rs1}, ${imm}`);
                        }
                    } else { // Compile time math
                        let val = this.parseValue(t1) + this.parseValue(tokens[3]);
                        this.emitLoadConst(rd, val);
                    }
                    pc += 4; continue;
                }

                // Immediate / Move: x10 0xAA
                if (this.isReg(t1)) {
                    this.emitI(0x13, 0, rd, this.parseReg(t1), 0, `MV x${rd}, x${this.parseReg(t1)}`);
                } else {
                    this.emitLoadConst(rd, this.parseValue(t1));
                }
                pc += 4; continue;
            }
            
            // Jumps (Labels)
            if (this.labels[t0] !== undefined) {
                const offset = this.labels[t0] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${t0} (${offset})`);
                pc += 4; continue;
            }
        }
    }

    // --- HELPERS & EMITTERS ---
    emitTrace(str) { this.asmTrace.push(str); }
    emitLoadConst(rd, val) {
        if (val >= -2048 && val <= 2047) { this.emitI(0x13, 0, rd, 0, val, `LI x${rd}, ${val}`); } 
        else { const uimm = (val >>> 12) & 0xFFFFF; this.emitU(0x37, rd, uimm, `LUI x${rd}, 0x${uimm.toString(16)}`); }
    }
    parseReg(str) { if (RISCV.REGS[str] !== undefined) return RISCV.REGS[str]; throw new Error(`Unknown register: ${str}`); }
    isReg(str) { return RISCV.REGS[str] !== undefined; }
    parseValue(str) {
        if (!str) return 0;
        let multiplier = 1;
        if (str.toLowerCase().endsWith('kb')) { multiplier = 1024; str = str.slice(0, -2); }
        else if (str.toLowerCase().endsWith('mb')) { multiplier = 1024 * 1024; str = str.slice(0, -2); }
        if (this.constants[str] !== undefined) return this.constants[str] * multiplier;
        if (this.labels[str] !== undefined) return this.labels[str]; 
        if (str.startsWith('0x')) return parseInt(str, 16) * multiplier;
        if (str.startsWith("'")) return str.charCodeAt(1) * multiplier;
        const val = parseInt(str);
        if (!isNaN(val)) return val * multiplier;
        return 0;
    }
    pushWord(word) { this.code.push(word & 0xFF, (word >> 8) & 0xFF, (word >> 16) & 0xFF, (word >> 24) & 0xFF); }
    emitR(op, f3, f7, rd, rs1, rs2, asm="") { this.pushWord((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
    emitI(op, f3, rd, rs1, imm, asm="") { this.pushWord(((imm & 0xFFF) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
    emitS(op, f3, rs1, rs2, imm, asm="") { this.pushWord((((imm >> 5) & 0x7F) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1F) << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
    emitU(op, rd, imm, asm="") { this.pushWord((imm << 12) | (rd << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
    emitB(op, f3, rs1, rs2, imm, asm="") { this.pushWord((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (((imm >> 1) & 0xF) << 8) | (((imm >> 11) & 1) << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
    emitJ(op, rd, imm, asm="") { this.pushWord((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3FF) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xFF) << 12) | (rd << 7) | op); if(asm) this.emitTrace(`  ` + asm); }
}

// --- APP UI ---
const State = {
    theme: 'light', activeView: 'files', currentFile: 'boot',
    files: {
        'boot': `; MULTIX System Assembly\n; Демо: Мінімалізм і ручні стеки\n\nRAM 0x8000\n\n: RAM\n    x31 RAM + 0x1000        ; Ініціалізація стека\n\n    x10 0xAA                ; Аргумент\n    [--x31] x10             ; Push аргумента\n    \n    process [--x31]         ; Call функції 'process'\n    \n    x11 [x31++]             ; Pop результату\n    _                       ; Halt\n\nprocess:\n    x5 [x31++]              ; Pop аргумента в x5\n    x5 x5 + 1               ; Робота\n    \n    [--x31] x5              ; Push результату\n    = [x31++]               ; Return (Pop & Jump)`
    }
};

const UI = {
    editor: document.getElementById('code-editor'), lines: document.getElementById('line-numbers'),
    treeView: document.getElementById('tree-view'), console: document.getElementById('console-output'),
    navFiles: document.getElementById('nav-files'), navAI: document.getElementById('nav-ai'),
    navBuild: document.getElementById('nav-build'), navTheme: document.getElementById('nav-theme'),
    btnClear: document.getElementById('btn-clear-console')
};

const App = {
    compiler: new Assembler(),
    init: function() {
        App.renderTree(); App.openFile(State.currentFile);
        UI.editor.addEventListener('input', App.updateLines);
        UI.editor.addEventListener('scroll', () => { UI.lines.scrollTop = UI.editor.scrollTop; });
        UI.navFiles.addEventListener('click', () => App.switchSidebar('files'));
        UI.navAI.addEventListener('click', () => App.switchSidebar('ai'));
        UI.navTheme.addEventListener('click', App.toggleTheme);
        UI.navBuild.addEventListener('click', App.build);
        UI.btnClear.addEventListener('click', () => UI.console.innerHTML = '');
        log("MULTIX Dev Environment Ready (v0.9)", "sys");
    },
    openFile: function(name) {
        State.currentFile = name; UI.editor.value = State.files[name]; App.updateLines();
        document.querySelectorAll('.list-item').forEach(el => { el.classList.remove('active'); if (el.dataset.name === name) el.classList.add('active'); });
    },
    renderTree: function() {
        UI.treeView.innerHTML = '';
        Object.keys(State.files).forEach(name => {
            const div = document.createElement('div'); div.className = 'list-item'; div.dataset.name = name;
            div.innerHTML = `<span class="file-icon">📄</span> ${name}`; div.onclick = () => App.openFile(name);
            UI.treeView.appendChild(div);
        });
    },
    switchSidebar: function(view) {
        const aiView = document.getElementById('ai-interface'); const chatList = document.getElementById('chat-list-view');
        if (view === 'files') {
            UI.navFiles.classList.add('active'); UI.navAI.classList.remove('active');
            UI.treeView.classList.remove('hidden'); chatList.classList.add('hidden');
            document.getElementById('panel-title').textContent = "EXPLORER"; aiView.classList.add('hidden');
            document.getElementById('editor-wrapper').classList.remove('hidden');
        } else {
            UI.navFiles.classList.remove('active'); UI.navAI.classList.add('active');
            UI.treeView.classList.add('hidden'); chatList.classList.remove('hidden');
            document.getElementById('panel-title').textContent = "AI ARCHITECT"; aiView.classList.remove('hidden');
        }
    },
    toggleTheme: function() {
        const body = document.body; body.setAttribute('data-theme', body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
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
            log("Binary Output (Hex):", "sys"); log(hex);
        }
    }
};

function log(msg, type="") {
    const time = new Date().toLocaleTimeString(); const cls = type ? `log-${type}` : '';
    const html = `<div style="white-space: pre-wrap;"><span class="log-time">[${time}]</span><span class="${cls}">${msg}</span></div>`;
    UI.console.insertAdjacentHTML('beforeend', html); UI.console.scrollTop = UI.console.scrollHeight;
}

document.addEventListener('DOMContentLoaded', App.init);
