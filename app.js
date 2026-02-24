// MULTIX Code - Bootstrap Environment
// v0.9.1 - Positional Range Loops (& x4 x1 x2)

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
        
        log("Build started (v0.9.1)...", "sys");
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
        this.origin = 0; this.lines = []; this.asmTrace = []; this.blockCounter = 0;
    }

    pass1() {
        let pc = 0; let inCode = false; let blockStack = [];

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text; let tokens = line.split(/\s+/); let indent = this.lines[i].indent;

            while (blockStack.length > 0 && indent <= blockStack[blockStack.length - 1].indent) {
                let b = blockStack.pop();
                if (b.type === 'while') pc += 4; 
                else if (b.type === 'range') pc += 8; // ADDI step + JAL back
            }

            if (line.startsWith(':')) {
                inCode = true; const valStr = tokens[1];
                if (valStr) { const val = this.parseValue(valStr); this.origin = val; pc = val; }
                this.labels[':'] = pc; continue;
            }
            if (line.endsWith(':')) { inCode = true; this.labels[line.slice(0, -1)] = pc; continue; }

            if (!inCode) { this.constants[tokens[0]] = this.parseValue(tokens[1]); continue; }

            let t0 = tokens[0];

            if (t0 === '_') { pc += 4; continue; }
            if (t0 === '=') { pc += 12; continue; }
            if (tokens.length >= 2 && tokens[1].startsWith('[--')) { pc += 20; continue; }
            if (t0 === '.' || t0 === '..') { pc += 4; continue; }

            // Логіка блоків (& та ?)
            if (t0 === '&' || t0 === '?') {
                this.blockCounter++;
                let startLabel = `_B_START_${this.blockCounter}`, endLabel = `_B_END_${this.blockCounter}`;
                
                // Перевірка чи це Range Loop: & x4 x1 x2 [step]
                let isRange = t0 === '&' && !['<', '>', '==', '!=', '<=', '>='].includes(tokens[2]) && tokens.length >= 4;

                if (isRange) {
                    this.labels[startLabel] = pc + 4; // Мітка після ініціалізації
                    blockStack.push({ type: 'range', indent: indent, start: startLabel, end: endLabel, reg: tokens[1], step: tokens[4] ? parseInt(tokens[4]) : 1 });
                    pc += 8; // MV + BGE
                    continue;
                } else {
                    if (t0 === '&') this.labels[startLabel] = pc;
                    blockStack.push({ type: t0 === '&' ? 'while' : 'if', indent: indent, start: startLabel, end: endLabel });
                    pc += 4; continue;
                }
            }

            if (t0.startsWith('[')) { pc += t0.startsWith('[--') ? 8 : 4; continue; }
            if (this.isReg(t0)) {
                if (tokens[1] && tokens[1].startsWith('[')) pc += tokens[1].includes('++') ? 8 : 4;
                else if (tokens.length > 2 && ['+','-','|','&','^'].includes(tokens[2])) pc += 4; 
                else pc += 4; 
                continue;
            }
            if (this.labels[t0] !== undefined || t0.match(/^[a-zA-Z_]\w*$/)) { pc += 4; continue; } 
        }

        while (blockStack.length > 0) {
            let b = blockStack.pop();
            pc += b.type === 'range' ? 8 : 4;
            this.labels[b.end] = pc;
        }
    }

    pass2() {
        let pc = this.origin; let inCode = false; let blockStack = []; let bCounter = 0;

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text; let tokens = line.split(/\s+/); let indent = this.lines[i].indent;

            while (blockStack.length > 0 && indent <= blockStack[blockStack.length - 1].indent) {
                let b = blockStack.pop();
                if (b.type === 'while') {
                    let offset = this.labels[b.start] - pc;
                    this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Loop Back)`); pc += 4;
                } else if (b.type === 'range') {
                    let reg = this.parseReg(b.reg);
                    this.emitI(0x13, 0, reg, reg, b.step, `ADDI x${reg}, x${reg}, ${b.step}`); pc += 4;
                    let offset = this.labels[b.start] - pc;
                    this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Range Next)`); pc += 4;
                }
                this.emitTrace(`; --- End of Block ${b.end} ---`);
            }

            if (line.startsWith(':') || line.endsWith(':')) {
                inCode = true; if (line.startsWith(':')) this.emitTrace(`\n; ${line} (Origin: 0x${pc.toString(16)})`);
                continue;
            }

            if (!inCode) continue;

            this.emitTrace(`\n; ${line}`);
            let t0 = tokens[0];

            if (t0 === '_') { this.emitJ(0x6F, 0, 0, `JAL x0, 0 (Halt)`); pc += 4; continue; }
            if (t0 === '=') {
                let memToken = tokens[1];
                if (memToken.includes('++')) {
                    let reg = this.parseReg(memToken.replace(/[\[\]\+]/g, ''));
                    this.emitI(0x03, 3, 1, reg, 0, `LD x1, 0(x${reg})`);
                    this.emitI(0x13, 0, reg, reg, 8, `ADDI x${reg}, x${reg}, 8`);
                    this.emitI(0x67, 0, 0, 1, 0, `JALR x0, 0(x1)`); 
                    pc += 12; continue;
                }
            }

            if (tokens.length >= 2 && tokens[1].startsWith('[--')) {
                let target = t0; let reg = this.parseReg(tokens[1].replace(/[\[\]\-]/g, ''));
                this.emitU(0x17, 1, 0, `AUIPC x1, 0`); 
                this.emitI(0x13, 0, 1, 1, 20, `ADDI x1, x1, 20`); 
                this.emitI(0x13, 0, reg, reg, -8, `ADDI x${reg}, x${reg}, -8`); 
                this.emitS(0x23, 3, reg, 1, 0, `SD x1, 0(x${reg})`); 
                let offset = this.labels[target] - pc - 16;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${target} (${offset})`); 
                pc += 20; continue;
            }

            if (t0 === '.' || t0 === '..') {
                let loopBlock = [...blockStack].reverse().find(b => b.type === 'while' || b.type === 'range');
                let targetLabel = t0 === '.' ? loopBlock.end : loopBlock.start;
                let offset = this.labels[targetLabel] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (${t0 === '.' ? 'break' : 'continue'})`);
                pc += 4; continue;
            }

            // Блоки
            if (t0 === '&' || t0 === '?') {
                bCounter++;
                let startLabel = `_B_START_${bCounter}`, endLabel = `_B_END_${bCounter}`;
                let isRange = t0 === '&' && !['<', '>', '==', '!=', '<=', '>='].includes(tokens[2]) && tokens.length >= 4;

                if (isRange) {
                    let r1 = this.parseReg(tokens[1]), r2 = this.parseReg(tokens[2]), r3 = this.parseReg(tokens[3]);
                    let step = tokens[4] ? parseInt(tokens[4]) : 1;
                    blockStack.push({ type: 'range', indent: indent, start: startLabel, end: endLabel, reg: tokens[1], step: step });
                    
                    this.emitI(0x13, 0, r1, r2, 0, `MV x${r1}, x${r2} (Init Iterator)`); pc += 4;
                    let offset = this.labels[endLabel] - pc;
                    this.emitB(0x63, 5, r1, r3, offset, `BGE x${r1}, x${r3}, END_RANGE`); pc += 4;
                    continue;
                } else {
                    blockStack.push({ type: t0 === '&' ? 'while' : 'if', indent: indent, start: startLabel, end: endLabel });
                    let rs1 = this.parseReg(tokens[1]), op = tokens[2], rs2 = this.parseReg(tokens[3]);
                    let offset = this.labels[endLabel] - pc;

                    if (op === '<') this.emitB(0x63, 5, rs1, rs2, offset, `BGE x${rs1}, x${rs2}, END_BLOCK`);
                    else if (op === '>=') this.emitB(0x63, 4, rs1, rs2, offset, `BLT x${rs1}, x${rs2}, END_BLOCK`);
                    else if (op === '==') this.emitB(0x63, 1, rs1, rs2, offset, `BNE x${rs1}, x${rs2}, END_BLOCK`);
                    else if (op === '!=') this.emitB(0x63, 0, rs1, rs2, offset, `BEQ x${rs1}, x${rs2}, END_BLOCK`);
                    pc += 4; continue;
                }
            }

            if (t0.startsWith('[')) {
                let srcReg = this.parseReg(tokens[1]);
                if (t0.startsWith('[--')) { 
                    let reg = this.parseReg(t0.replace(/[\[\]\-]/g, ''));
                    this.emitI(0x13, 0, reg, reg, -8, `ADDI x${reg}, x${reg}, -8`);
                    this.emitS(0x23, 3, reg, srcReg, 0, `SD x${srcReg}, 0(x${reg})`);
                    pc += 8; continue;
                } else { 
                    let reg = this.parseReg(t0.replace(/[\[\]]/g, ''));
                    this.emitS(0x23, 3, reg, srcReg, 0, `SD x${srcReg}, 0(x${reg})`);
                    pc += 4; continue;
                }
            }

            if (this.isReg(t0)) {
                let rd = this.parseReg(t0); let t1 = tokens[1];
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
                if (tokens.length > 2 && ['+','-','|','&','^'].includes(tokens[2])) {
                    if (this.isReg(t1)) {
                        let rs1 = this.parseReg(t1);
                        if (this.isReg(tokens[3])) this.emitR(0x33, 0, 0, rd, rs1, this.parseReg(tokens[3]), `ADD x${rd}, x${rs1}, x${this.parseReg(tokens[3])}`);
                        else this.emitI(0x13, 0, rd, rs1, this.parseValue(tokens[3]), `ADDI x${rd}, x${rs1}, ${this.parseValue(tokens[3])}`);
                    } else {
                        this.emitLoadConst(rd, this.parseValue(t1) + this.parseValue(tokens[3]));
                    }
                    pc += 4; continue;
                }
                if (this.isReg(t1)) this.emitI(0x13, 0, rd, this.parseReg(t1), 0, `MV x${rd}, x${this.parseReg(t1)}`);
                else this.emitLoadConst(rd, this.parseValue(t1));
                pc += 4; continue;
            }
            
            if (this.labels[t0] !== undefined) {
                const offset = this.labels[t0] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${t0} (${offset})`);
                pc += 4; continue;
            }
        }
        
        while (blockStack.length > 0) {
            let b = blockStack.pop();
            if (b.type === 'while') {
                let offset = this.labels[b.start] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Loop Back)`); pc += 4;
            } else if (b.type === 'range') {
                let reg = this.parseReg(b.reg);
                this.emitI(0x13, 0, reg, reg, b.step, `ADDI x${reg}, x${reg}, ${b.step}`); pc += 4;
                let offset = this.labels[b.start] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Range Next)`); pc += 4;
            }
            this.emitTrace(`; --- End of Block ${b.end} ---`);
        }
    }

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

const State = {
    theme: 'light', activeView: 'files', currentFile: 'boot',
    files: {
        'boot': `; MULTIX System Assembly\n; Безпечний цикл та робота з пам'яттю\n\nRAM 0x8000\n\n: RAM\n    x1 RAM + 0x100          ; Початок буфера\n    x2 RAM + 0x120          ; Кінець буфера\n    x3 0xAA                 ; Значення для заповнення\n\n    & x4 x1 x2 8            ; Безпечний цикл по 8 байт (Iterator: x4)\n        [x4] x3             ; Запис значення в пам'ять\n\n    _                       ; Halt`
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
        log("MULTIX Dev Environment Ready (v0.9.1)", "sys");
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
