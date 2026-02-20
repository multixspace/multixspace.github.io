// MULTIX Code - Bootstrap Environment
// v0.6 - Shadow Stack (->, <-), Blocks (&, ?), ASM Trace

const RISCV = {
    OP: {
        LUI: 0x37, AUIPC: 0x17, JAL: 0x6F, JALR: 0x67,
        BRANCH: 0x63, LOAD: 0x03, STORE: 0x23,
        IMM: 0x13, OP: 0x33, SYSTEM: 0x73
    },
    REGS: {}
};
for (let i = 0; i < 32 - 1; i++) RISCV.REGS[`x${i}`] = i;

class Assembler {
    constructor() {
        this.reset();
    }

    compile(source) {
        this.reset();
        
        let cleanSource = source.replace(/;-(.|[\r\n])*?-;/g, '');
        
        // Track indentation and lines
        let rawLines = cleanSource.split('\n');
        for (let l of rawLines) {
            const commentIdx = l.indexOf(';');
            let text = commentIdx !== -1 ? l.substring(0, commentIdx) : l;
            if (text.trim() === '') continue;
            
            // Calculate indentation (number of leading spaces)
            const indent = text.search(/\S|$/);
            this.lines.push({ text: text.trim(), indent: indent });
        }
        
        log("Build started...", "sys");

        try {
            this.pass1();
            this.pass2();
            
            log(`Build Success. Size: ${this.code.length} bytes.`, "success");
            
            // Print ASM Trace
            log("--- INTERMEDIATE RISC-V ASM ---", "sys");
            for (let t of this.asmTrace) log(t);
            log("-------------------------------", "sys");

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
        this.origin = 0;
        this.lines = [];
        this.asmTrace = [];
        this.blockCounter = 0;
    }

    // --- PASS 1: Calculate offsets and block sizes ---
    pass1() {
        let pc = 0; 
        let blockStack = [];

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text;
            let indent = this.lines[i].indent;

            // Check block exits
            while (blockStack.length > 0 && indent <= blockStack[blockStack.length - 1].indent) {
                let b = blockStack.pop();
                if (b.type === 'while') pc += 4; // JAL back to loop start
            }

            if (line.startsWith('#')) {
                const parts = line.substring(1).split('=');
                this.constants[parts[0].trim()] = this.parseValue(parts[1].trim());
                continue;
            }
            if (line.startsWith('@')) {
                const val = this.parseValue(line.substring(1).trim());
                this.origin = val; pc = val;
                continue;
            }
            if (line === ':') { this.labels[':'] = pc; continue; }
            if (line.endsWith(':')) { this.labels[line.slice(0, -1)] = pc; continue; }

            // Shadow Stack
            if (line.endsWith('->')) {
                // If "Label ->" (Call) = 5 instructions = 20 bytes
                // If just "->" (Push PC) = 4 instructions = 16 bytes
                pc += line === '->' ? 16 : 20;
                continue;
            }
            if (line === '<-') {
                pc += 12; // 3 instructions
                continue;
            }

            // Blocks (& While, ? If)
            if (line.startsWith('&') || line.startsWith('?')) {
                this.blockCounter++;
                let bType = line.startsWith('&') ? 'while' : 'if';
                let startLabel = `_B_START_${this.blockCounter}`;
                let endLabel = `_B_END_${this.blockCounter}`;
                
                if (bType === 'while') this.labels[startLabel] = pc;
                blockStack.push({ type: bType, indent: indent, start: startLabel, end: endLabel });
                
                pc += 4; // Conditional branch instruction
                continue;
            }

            if (line === '=') { pc += 4; continue; } // Halt / Return fallback
            if (line.includes('=')) { pc += 4; continue; } // Assignments (assume 4 bytes for bootstrap)
            if (this.labels[line] !== undefined || line.match(/^[a-zA-Z_]\w*$/)) { pc += 4; continue; } // Jumps
        }

        // Close remaining blocks
        while (blockStack.length > 0) {
            let b = blockStack.pop();
            if (b.type === 'while') pc += 4;
            this.labels[b.end] = pc;
        }
    }

    // --- PASS 2: Generate Code & ASM Trace ---
    pass2() {
        let pc = this.origin;
        let blockStack = [];
        let bCounter = 0;

        for (let i = 0; i < this.lines.length; i++) {
            let line = this.lines[i].text;
            let indent = this.lines[i].indent;

            // Handle block exits
            while (blockStack.length > 0 && indent <= blockStack[blockStack.length - 1].indent) {
                let b = blockStack.pop();
                if (b.type === 'while') {
                    let offset = this.labels[b.start] - pc;
                    this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Loop Back)`);
                    pc += 4;
                }
                this.emitTrace(`; --- End of Block ${b.end} ---`);
            }

            if (line.startsWith('#') || line.endsWith(':') || line === ':' || line.startsWith('@')) continue;

            // Print original line as comment in trace
            this.emitTrace(`\n; ${line}`);

            // --- Shadow Call Stack ---
            if (line.endsWith('->')) {
                let target = line.replace('->', '').trim();
                
                // 1. Push PC to [x31]
                this.emitU(0x17, 1, 0, `AUIPC x1, 0`); // x1 = PC
                let pushOffset = target ? 20 : 16;
                this.emitI(0x13, 0, 1, 1, pushOffset, `ADDI x1, x1, ${pushOffset}`); // x1 = PC + offset
                this.emitS(0x23, 3, 31, 1, 0, `SD x1, 0(x31)`); // [x31] = x1
                this.emitI(0x13, 0, 31, 31, 8, `ADDI x31, x31, 8`); // x31 += 8
                pc += 16;

                // 2. Jump if target exists
                if (target) {
                    let offset = this.labels[target] - pc;
                    this.emitJ(0x6F, 0, offset, `JAL x0, ${target} (${offset})`);
                    pc += 4;
                }
                continue;
            }

            if (line === '<-') {
                this.emitI(0x13, 0, 31, 31, -8, `ADDI x31, x31, -8`); // x31 -= 8
                this.emitI(0x03, 3, 1, 31, 0, `LD x1, 0(x31)`); // x1 = [x31]
                this.emitI(0x67, 0, 0, 1, 0, `JALR x0, 0(x1)`); // Jump x1
                pc += 12;
                continue;
            }

            // --- Blocks (&, ?) ---
            if (line.startsWith('&') || line.startsWith('?')) {
                bCounter++;
                let bType = line.startsWith('&') ? 'while' : 'if';
                let startLabel = `_B_START_${bCounter}`;
                let endLabel = `_B_END_${bCounter}`;
                blockStack.push({ type: bType, indent: indent, start: startLabel, end: endLabel });
                
                // Parse condition (e.g. x1 < x2)
                let cond = line.substring(1).trim();
                let m = cond.match(/(x\d+)\s*(==|!=|<|>=)\s*(x\d+)/);
                if (!m) throw new Error(`Invalid condition: ${cond}`);
                
                let rs1 = this.parseReg(m[1]);
                let op = m[2];
                let rs2 = this.parseReg(m[3]);
                let offset = this.labels[endLabel] - pc;

                // Invert condition to jump PAST the block
                // <  (BLT) -> BGE
                // >= (BGE) -> BLT
                // == (BEQ) -> BNE
                // != (BNE) -> BEQ
                if (op === '<') this.emitB(0x63, 5, rs1, rs2, offset, `BGE x${rs1}, x${rs2}, END_BLOCK`);
                else if (op === '>=') this.emitB(0x63, 4, rs1, rs2, offset, `BLT x${rs1}, x${rs2}, END_BLOCK`);
                else if (op === '==') this.emitB(0x63, 1, rs1, rs2, offset, `BNE x${rs1}, x${rs2}, END_BLOCK`);
                else if (op === '!=') this.emitB(0x63, 0, rs1, rs2, offset, `BEQ x${rs1}, x${rs2}, END_BLOCK`);
                
                pc += 4;
                continue;
            }

            // --- Assignments ---
            if (line.includes('=')) {
                if (line === '=') {
                    this.emitJ(0x6F, 0, 0, `JAL x0, 0 (Halt)`);
                    pc += 4; continue;
                }

                const parts = line.split('=');
                const destStr = parts[0].trim();
                const srcStr = parts[1].trim();
                
                if (destStr.startsWith('[') && destStr.endsWith(']')) {
                    const rs1 = this.parseReg(destStr.slice(1, -1));
                    const rs2 = this.parseReg(srcStr);
                    this.emitS(0x23, 3, rs1, rs2, 0, `SD x${rs2}, 0(x${rs1})`);
                    pc += 4; continue;
                }

                const rd = this.parseReg(destStr);

                if (srcStr.startsWith('[') && srcStr.endsWith(']')) {
                    const content = srcStr.slice(1, -1);
                    if (content.includes('+')) {
                         const mParts = content.split('+');
                         const rs1 = this.parseReg(mParts[0].trim());
                         const off = this.parseValue(mParts[1].trim());
                         this.emitI(0x03, 3, rd, rs1, off, `LD x${rd}, ${off}(x${rs1})`);
                    } else {
                         const rs1 = this.parseReg(content);
                         this.emitI(0x03, 3, rd, rs1, 0, `LD x${rd}, 0(x${rs1})`);
                    }
                    pc += 4; continue;
                }

                if (srcStr.includes('+')) {
                    const opParts = srcStr.split('+').map(s => s.trim());
                    const part1 = opParts[0];
                    const part2 = opParts[1];
                    
                    if (this.isReg(part1)) {
                        const rs1 = this.parseReg(part1);
                        if (this.isReg(part2)) {
                            const rs2 = this.parseReg(part2);
                            this.emitR(0x33, 0, 0, rd, rs1, rs2, `ADD x${rd}, x${rs1}, x${rs2}`);
                        } else {
                            const imm = this.parseValue(part2);
                            this.emitI(0x13, 0, rd, rs1, imm, `ADDI x${rd}, x${rs1}, ${imm}`);
                        }
                    } else {
                        const val1 = this.parseValue(part1);
                        const val2 = this.parseValue(part2);
                        this.emitLoadConst(rd, val1 + val2);
                    }
                } else {
                    if (this.isReg(srcStr)) {
                        const rs1 = this.parseReg(srcStr);
                        this.emitI(0x13, 0, rd, rs1, 0, `MV x${rd}, x${rs1}`);
                    } else {
                        const imm = this.parseValue(srcStr);
                        this.emitLoadConst(rd, imm);
                    }
                }
                pc += 4; continue;
            }
            
            // --- Jumps (Labels) ---
            if (this.labels[line] !== undefined) {
                const offset = this.labels[line] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${line} (${offset})`);
                pc += 4; continue;
            }
        }
        
        // Close end of file blocks
        while (blockStack.length > 0) {
            let b = blockStack.pop();
            if (b.type === 'while') {
                let offset = this.labels[b.start] - pc;
                this.emitJ(0x6F, 0, offset, `JAL x0, ${offset} (Loop Back)`);
                pc += 4;
            }
            this.emitTrace(`; --- End of Block ${b.end} ---`);
        }
    }

    // --- EMITTERS ---
    emitTrace(str) { this.asmTrace.push(str); }
    
    emitLoadConst(rd, val) {
        if (val >= -2048 && val <= 2047) {
            this.emitI(0x13, 0, rd, 0, val, `LI x${rd}, ${val}`);
        } else if ((val & 0xFFF) === 0) {
            const uimm = (val >>> 12) & 0xFFFFF;
            this.emitU(0x37, rd, uimm, `LUI x${rd}, 0x${uimm.toString(16)}`);
        } else {
            const uimm = (val >>> 12) & 0xFFFFF;
            this.emitU(0x37, rd, uimm, `LUI x${rd}, 0x${uimm.toString(16)} (trunc)`);
        }
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

    emitR(opcode, funct3, funct7, rd, rs1, rs2, asm="") {
        this.pushWord((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
    emitI(opcode, funct3, rd, rs1, imm, asm="") {
        this.pushWord(((imm & 0xFFF) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
    emitS(opcode, funct3, rs1, rs2, imm, asm="") {
        const imm11_5 = (imm >> 5) & 0x7F;
        const imm4_0 = imm & 0x1F;
        this.pushWord((imm11_5 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (imm4_0 << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
    emitU(opcode, rd, imm, asm="") { 
        this.pushWord((imm << 12) | (rd << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
    // Branch Format (B-Type)
    emitB(opcode, funct3, rs1, rs2, imm, asm="") {
        const i12 = (imm >> 12) & 1;
        const i10_5 = (imm >> 5) & 0x3F;
        const i4_1 = (imm >> 1) & 0xF;
        const i11 = (imm >> 11) & 1;
        this.pushWord((i12 << 31) | (i10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (i4_1 << 8) | (i11 << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
    emitJ(opcode, rd, imm, asm="") {
        const i20 = (imm >> 20) & 1;
        const i10_1 = (imm >> 1) & 0x3FF;
        const i11 = (imm >> 11) & 1;
        const i19_12 = (imm >> 12) & 0xFF;
        this.pushWord((i20 << 31) | (i10_1 << 21) | (i11 << 20) | (i19_12 << 12) | (rd << 7) | opcode);
        if(asm) this.emitTrace(`  ` + asm);
    }
}

// --- APP UI ---
const State = {
    theme: 'light',
    activeView: 'files',
    files: {
        'boot': `; MULTIX System Assembly\n; Test Shadow Stack & Loops\n\n# RAM = 0x8000\n\n@ RAM\n\n:\n    x31 = RAM + 0x100  ; Init Shadow Stack\n    \n    print_hello ->     ; Call subroutine\n    \n    =                  ; Halt\n\nprint_hello:\n    x1 = 0\n    x2 = 3\n    \n    & x1 < x2          ; While x1 < 3\n        x5 = 'A'\n        x1 = x1 + 1\n        \n    <-                 ; Return`
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

        log("MULTIX Dev Environment Ready (v0.6)", "sys");
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
    // Preserve whitespace for ASM trace
    const html = `<div style="white-space: pre-wrap;"><span class="log-time">[${time}]</span><span class="${cls}">${msg}</span></div>`;
    UI.console.insertAdjacentHTML('beforeend', html);
    UI.console.scrollTop = UI.console.scrollHeight;
}

document.addEventListener('DOMContentLoaded', App.init);
