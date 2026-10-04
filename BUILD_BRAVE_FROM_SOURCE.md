# Building Brave (Ferox) from Source (C++ / Chromium)

This document describes how to clone and compile the full C++ Brave Browser source code (`brave-core`) with the 3x/4x YouTube speed modifications.

---

## 1. System Requirements

- **OS**: Windows 10/11 (64-bit), macOS (arm64/x64), or Linux (Ubuntu 22.04+)
- **Disk Space**: At least **120 GB** free space (Chromium source tree + build artifacts)
- **RAM**: Minimum **16 GB** (32 GB+ recommended)
- **CPU**: Multi-core processor (8+ cores recommended for faster compilation)
- **Tools**: Visual Studio 2022 (with C++ Desktop development and Windows 10/11 SDK), Git, Python 3.10+

---

## 2. Step-by-Step Setup

### Step 1: Install Chromium `depot_tools`
```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git C:\src\depot_tools
```
Add `C:\src\depot_tools` to the front of your system `PATH`.

### Step 2: Clone `brave-browser`
```bash
git clone https://github.com/brave/brave-browser.git C:\src\ferox
cd C:\src\ferox
```

### Step 3: Initialize and Sync Chromium & `brave-core`
```bash
npm install
npm run init
```
*Note: This step downloads the Chromium source tree (~35 GB download, ~80 GB uncompressed) and sets up `src/brave`.*

### Step 4: Apply the Ferox 3x/4x YouTube Patch
Navigate to `src/brave` and apply the patch:
```bash
cd src/brave
git apply C:\Users\merin\Documents\My Automations\Random Ideas\Ferox\patches\brave_core_youtube_speeds.patch
```

### Step 5: Compile Ferox
From the root `C:\src\ferox` directory:
```bash
# Generate GN build configuration for Release x64
npm run create_dist -- --target_os=win --target_arch=x64

# Compile using Ninja
npm run build -- Release
```

### Step 6: Locate the Compiled Binary
After compilation completes, the native executable will be located at:
```
C:\src\ferox\src\out\Release\brave.exe
```

---

## 3. Automated Scripts

You can also execute the automated PowerShell scripts in this repo:
- [`scripts/fork_and_setup.ps1`](file:///c:/Users/merin/Documents/My%20Automations/Random%20Ideas/Ferox/scripts/fork_and_setup.ps1)
- [`scripts/build_brave.ps1`](file:///c:/Users/merin/Documents/My%20Automations/Random%20Ideas/Ferox/scripts/build_brave.ps1)
