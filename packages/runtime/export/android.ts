import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSlug } from './desktop';
import { exportWeb } from './export';

/**
 * `vibe package android <project>`: the exported game inside a Capacitor Android app, built with Gradle
 * into a debug .apk that installs straight on a phone (no store signature).
 *
 *   build/<project>/android            Capacitor project (web/ + capacitor.config.json + android/ Gradle project)
 *   build/<project>/android/<slug>.apk the app
 *
 * The app: landscape, full screen (system bars hidden, a swipe shows them), the save in the Preferences
 * plugin (the player finds it through the native bridge), back button = Android's default.
 */

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const require = createRequire(import.meta.url);
const versionOf = (pkg: string): string => require(`${pkg}/package.json`).version;

// Gradle 9.1+ runs on Java 25 (the JDK that comes with Android Studio); Capacitor's template has 8.14.
const GRADLE_VERSION = '9.1.0';

export interface AndroidOptions {
  outDir?: string;
  /** JDK for Gradle (default: JAVA_HOME, else Android Studio's jbr). */
  javaHome?: string;
  /** Android SDK (default: ANDROID_HOME / ANDROID_SDK_ROOT, else %LOCALAPPDATA%/Android/Sdk). */
  sdkDir?: string;
  /** Gradle output goes here (progress of a long first build). */
  log?: (line: string) => void;
}

export interface AndroidResult {
  projectDir: string;
  apk: string;
  appId: string;
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  return paths.find((p) => p && existsSync(p));
}

export function findJavaHome(explicit?: string) {
  const home = firstExisting([
    explicit,
    process.env.JAVA_HOME,
    'C:/Program Files/Android/Android Studio/jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/android-studio/jbr',
  ]);
  if (!home) throw new Error('No JDK found: install Android Studio or set JAVA_HOME');
  return home;
}

export function findAndroidSdk(explicit?: string) {
  const sdk = firstExisting([
    explicit,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Library', 'Android', 'sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk'),
  ]);
  if (!sdk) throw new Error('No Android SDK found: install Android Studio or set ANDROID_HOME');
  return sdk;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log?: (l: string) => void) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (log) out.split(/\r?\n/).filter(Boolean).forEach(log);
  if (r.status !== 0) throw new Error(`${basename(cmd)} ${args.join(' ')} failed (${r.status ?? r.error?.message}):\n${out.slice(-4000)}`);
  return out;
}

function edit(file: string, change: (text: string) => string) {
  const before = readFileSync(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`Could not adapt ${file} (Capacitor template changed?)`);
  writeFileSync(file, after);
}

function findFile(dir: string, name: string): string | undefined {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      const f = findFile(full, name);
      if (f) return f;
    } else if (d.name === name) return full;
  }
  return undefined;
}

export async function packageAndroid(projectDir: string, o: AndroidOptions = {}): Promise<AndroidResult> {
  const name = basename(resolve(projectDir));
  const outDir = o.outDir ?? repo(`build/${name}/android`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const web = await exportWeb(projectDir, join(outDir, 'web'));
  const slug = appSlug(web.game.name);
  const appId = `com.vibegame.${slug.replaceAll('-', '')}`;
  // The Capacitor CLI finds the platform and the plugins from this package.json (resolved in the repo's node_modules).
  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(
      {
        name: slug,
        private: true,
        dependencies: Object.fromEntries(['@capacitor/core', '@capacitor/android', '@capacitor/preferences'].map((p) => [p, versionOf(p)])),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(outDir, 'capacitor.config.json'), JSON.stringify({ appId, appName: web.game.title, webDir: 'web', android: { backgroundColor: '#000000' } }, null, 2));

  const javaHome = findJavaHome(o.javaHome);
  const sdkDir = findAndroidSdk(o.sdkDir);
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdkDir, ANDROID_SDK_ROOT: sdkDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const cap = require.resolve('@capacitor/cli/bin/capacitor');
  run(process.execPath, [cap, 'add', 'android'], outDir, env, o.log);

  const android = join(outDir, 'android');
  writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdkDir.replaceAll('\\', '/')}\n`);
  edit(join(android, 'gradle/wrapper/gradle-wrapper.properties'), (t) => t.replace(/gradle-[\d.]+-(all|bin)\.zip/, `gradle-${GRADLE_VERSION}-bin.zip`));
  // A landscape game: the app stays landscape (either side).
  const landscape = (web.game.width >= web.game.height ? 'sensorLandscape' : 'sensorPortrait');
  edit(join(android, 'app/src/main/AndroidManifest.xml'), (t) => t.replace('android:name=".MainActivity"', `android:name=".MainActivity"\n            android:screenOrientation="${landscape}"`));
  // Full screen: hide the status and navigation bars (a swipe from the edge shows them for a moment).
  const activity = findFile(join(android, 'app/src/main/java'), 'MainActivity.java');
  if (!activity) throw new Error('MainActivity.java not found in the Capacitor project');
  const pkg = /package\s+([\w.]+);/.exec(readFileSync(activity, 'utf8'))?.[1];
  writeFileSync(activity, mainActivity(pkg!));

  const gradle = ['assembleDebug', '--no-daemon', '--console=plain'];
  // Absolute path: cmd.exe may not look in the current folder (NoDefaultCurrentDirectoryInExePath).
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/c', join(android, 'gradlew.bat'), ...gradle], android, env, o.log);
  else run('./gradlew', gradle, android, env, o.log);
  const built = join(android, 'app/build/outputs/apk/debug/app-debug.apk');
  if (!existsSync(built)) throw new Error(`Gradle finished but ${built} is missing`);
  const apk = join(outDir, `${slug}.apk`);
  copyFileSync(built, apk);
  return { projectDir: outDir, apk, appId };
}

function mainActivity(pkg: string) {
  return `package ${pkg};

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

// Generated by vibe package android: a game fills the screen (system bars hidden).
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }
}
`;
}
