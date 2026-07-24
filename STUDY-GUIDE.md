# Study Guide — *PLC Programming with the Raspberry Pi and the OpenPLC Project* (Josef Bernhardt, 2021)

The book (194 pages, scanned into this knowledge base) teaches you to turn a
Raspberry Pi into a real IEC 61131-3 PLC using the free OpenPLC toolchain, then
grow it into a small industrial-style setup with HMI visualization and remote
Modbus I/O modules. Work through it in this order — each stage builds on the
previous one.

## Stage 1 — Turn the Pi into a PLC (Chapter 1, pp. 11–31)

Set up the hardware and the runtime that will execute your PLC programs.

- Raspberry Pi 4 hardware overview (a Pi Zero W also works, slower install) — p. 11
- Install Raspberry Pi OS with the Imager — p. 12
- Install VNC Viewer (remote desktop) — p. 15 — and WinSCP (file transfer) — p. 18
- Install the OpenPLC runtime on the Pi — p. 22

**Milestone:** the OpenPLC web interface runs on your Pi.

## Stage 2 — Set up the editor and test hardware (Chapter 2, pp. 32–43)

- Install the OpenPLC Editor on your PC — p. 32
- Raspberry Pi GPIO pin mapping (which pins are PLC inputs/outputs) — p. 37
- Build/attach the I/O test board with buttons and LEDs — p. 40 (circuit diagram p. 181)
- Optional 24 V PLC board for industrial-level signals — p. 41 (diagram p. 183)

**Milestone:** you can compile an example and upload it to the Pi.

## Stage 3 — Learn the five PLC languages (Chapter 3, pp. 44–119)

The core of the book. One worked example per IEC 61131-3 language:

| Language | Section | Pages |
|---|---|---|
| Editor tour | 3.1 | 44 |
| Ladder Logic (LD) | 3.2 | 55 |
| Function Block (FBD) | 3.3 | 67 |
| Instruction List (IL) | 3.4 | 76 |
| Structured Text (ST) | 3.5 | 81–108 |
| Sequential Function Chart (SFC) | 3.6 | 109 |

The ST section is the deepest: variables (p. 82), control structures (p. 83),
standard function blocks (p. 88), a first program (p. 90), a **conveyor-belt
controller** (p. 93), then arrays (p. 96), structs (p. 100), and ENUMs (p. 106).

**Milestone:** the conveyor-belt project in ST — the book's flagship exercise.

## Stage 4 — Talk to the outside world (Chapter 4, pp. 120–146)

- Test PLC programs over Modbus TCP — p. 120
- Build an HMI screen with AdvancedHMI to visualize your PLC live — p. 130
- Visualization over the internet — p. 140

**Milestone:** a PC dashboard showing your PLC's state in real time.

## Stage 5 — Build remote I/O modules (Chapter 5, pp. 147–174)

Expand beyond the Pi's GPIO with cheap microcontroller boards:

- Modbus RTU module with an Arduino UNO — p. 147
- Modbus TCP module with an ESP8266 over Wi-Fi — p. 158 (diagram p. 185)
- Web server application on the ESP8266 I/O module — p. 168

**Milestone:** your Pi PLC reads/writes I/O on a separate board over the network.

## Reference (Chapter 6, pp. 175–186)

Bibliography and web links (p. 176), Modbus command reference for the ESP8266
module (p. 178), and all circuit diagrams and layouts (p. 181).

---

## Studying with this tool

Ask the knowledge base as you go, e.g.:

```bash
npm run chat
❓ Walk me through installing the OpenPLC runtime on the Pi
❓ Which GPIO pins does OpenPLC use for inputs and outputs?
❓ Explain the conveyor belt example in Structured Text
❓ How do I connect AdvancedHMI to the Pi over Modbus TCP?
```

Every answer cites page numbers so you can jump to the book for figures and
full circuit diagrams (the scanner indexes text only — diagrams like the test
board schematic on p. 181 you'll want to view in the PDF itself).
