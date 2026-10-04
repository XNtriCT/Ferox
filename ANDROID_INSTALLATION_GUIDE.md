# 📱 Ferox Android App - Installation & Build Guide

The **Ferox Android Browser** brings all the desktop features to your mobile phone:
- 🦁 **Brave Shields**: Blocks popups, banner ads, tracking scripts, and YouTube video pre-roll/mid-roll ads.
- ⚡ **YouTube 3x & 4x Speed Multipliers**: On-screen floating HUD (`1x` to `4x`), pitch preservation, and persistent speed selection.
- 🎵 **Background Audio Playback**: Keep listening to YouTube music & videos even when your phone screen is locked or while multitasking in other apps!

---

## 📦 Option 1: Direct APK Download via GitHub Actions (Recommended)

1. Push your repository to GitHub.
2. Go to the **Actions** tab on your GitHub repository.
3. Select the **Build Ferox Android APK** workflow and click **Run workflow**.
4. Once completed (~2 minutes), download the **`Ferox-Android-Browser-APK`** artifact zip.
5. Extract `app-debug.apk` and transfer/install it directly on your Android phone!

---

## 🛠️ Option 2: Build & Install via Android Studio

1. Open **Android Studio**.
2. Select **Open** and choose the [`android/`](file:///c:/Users/merin/Documents/My%20Automations/Random%20Ideas/Ferox/android) folder from this project.
3. Connect your Android phone with **USB Debugging** enabled.
4. Click **Run (`Shift + F10`)** to install and run Ferox directly on your phone.

---

## 💻 Option 3: Install via ADB Command Line

If you have built `app-debug.apk` and your phone is plugged in with USB debugging:
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 📱 How to Use on Your Android Phone

1. Open **Ferox** on your phone.
2. It will automatically load **YouTube** with Brave Shields active (no ads!).
3. Tap on any video:
   - You will see the **`⚡ 1.0x ▲`** speed badge on the bottom-right of your screen.
   - Tap it to pick **`3.0x`** or **`4.0x`** speeds instantly!
4. **Background Playback**: Lock your phone or press the Home button — the video audio will continue playing seamlessly in the background.
