const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This harness needs POSIX executable files and zip. Run it on Linux/macOS CI;
// Windows bash.exe may launch WSL, which is not the local development runtime.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('unsigned iOS build script', () => {
  let directory;
  let binDirectory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-ipa-test-'));
    binDirectory = path.join(directory, 'bin');
    fs.mkdirSync(binDirectory);
    fs.mkdirSync(path.join(directory, 'ios', 'ReviewFixture.xcworkspace'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(__dirname, '..', 'build-unsigned-ipa.sh'),
      path.join(directory, 'build-unsigned-ipa.sh'),
    );
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      '{"version":"1.2.3"}',
    );
    for (const [name, body] of Object.entries({
      npx: 'echo "prebuild $*" >> "$IPA_TEST_TRACE"',
      pod: `echo "pods $*" >> "$IPA_TEST_TRACE"\nexit "\${IPA_TEST_POD_EXIT:-0}"`,
      xcodebuild: `echo "xcode $*" >> "$IPA_TEST_TRACE"
echo "variant=\${APP_VARIANT:-} skip=\${SKIP_BUNDLING:-}" >> "$IPA_TEST_TRACE"
configuration=Release
while [ "$#" -gt 0 ]; do
  if [ "$1" = -configuration ]; then configuration="$2"; break; fi
  shift
done
mkdir -p "build/$configuration-iphoneos/ReviewFixture.app"
echo binary > "build/$configuration-iphoneos/ReviewFixture.app/ReviewFixture"
if [ "\${IPA_TEST_MULTIPLE_APPS:-0}" = 1 ]; then
  mkdir -p "build/$configuration-iphoneos/Other.app"
fi`,
    })) {
      const filename = path.join(binDirectory, name);
      fs.writeFileSync(filename, `#!/bin/bash\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    }
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function run(extraEnv = {}) {
    return spawnSync('bash', ['build-unsigned-ipa.sh'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
        IPA_TEST_TRACE: path.join(directory, 'trace.txt'),
        APP_VARIANT: '',
        IOS_BUILD_CONFIGURATION: 'Release',
        IOS_BUILD_ARTIFACTS_DIR: '',
        ...extraEnv,
      },
    });
  }

  test('refreshes existing native code and preserves other artifacts and local Xcode settings', () => {
    const oldIpa = path.join(
      directory,
      'zhihu-minus-minus-v1.0.0-unsigned.ipa',
    );
    const localEnv = path.join(directory, 'ios', '.xcode.env.local');
    fs.writeFileSync(oldIpa, 'previous build');
    fs.writeFileSync(localEnv, '# user settings\n');
    fs.mkdirSync(path.join(directory, 'Payload'));
    fs.writeFileSync(path.join(directory, 'Payload', 'user-file'), 'keep');

    const result = run();
    expect(result.status).toBe(0);
    const trace = fs.readFileSync(path.join(directory, 'trace.txt'), 'utf8');
    expect(trace).toContain(
      'prebuild expo prebuild --platform ios --no-install',
    );
    expect(trace).toContain('pods install');
    expect(trace).toContain(
      '-workspace ios/ReviewFixture.xcworkspace -scheme ReviewFixture',
    );
    expect(fs.readFileSync(oldIpa, 'utf8')).toBe('previous build');
    expect(fs.readFileSync(localEnv, 'utf8')).toBe('# user settings\n');
    expect(fs.existsSync(path.join(directory, 'Payload', 'user-file'))).toBe(
      true,
    );
    const ipa = path.join(directory, 'zhihu-minus-minus-v1.2.3-unsigned.ipa');
    const entries = spawnSync('unzip', ['-Z1', ipa], { encoding: 'utf8' });
    expect(entries.status).toBe(0);
    expect(entries.stdout).toContain('Payload/ReviewFixture.app/ReviewFixture');
    expect(fs.readdirSync(path.join(directory, 'build'))).toEqual([
      'Release-iphoneos',
    ]);
  });

  test('stops before compiling when Pods installation fails', () => {
    expect(run({ IPA_TEST_POD_EXIT: '1' }).status).not.toBe(0);
    expect(
      fs.readFileSync(path.join(directory, 'trace.txt'), 'utf8'),
    ).not.toContain('xcode ');
  });

  test('builds a separate Debug IPA that loads JavaScript from Metro', () => {
    const result = run({ IOS_BUILD_CONFIGURATION: 'Debug' });
    expect(result.status).toBe(0);
    const trace = fs.readFileSync(path.join(directory, 'trace.txt'), 'utf8');
    expect(trace).toContain('-configuration Debug');
    expect(trace).toContain('variant=development skip=1');
    const ipa = path.join(
      directory,
      'zhihu-minus-minus-v1.2.3-dev-debug-unsigned.ipa',
    );
    const entries = spawnSync('unzip', ['-Z1', ipa], { encoding: 'utf8' });
    expect(entries.status).toBe(0);
    expect(entries.stdout).toContain('Payload/ReviewFixture.app/ReviewFixture');
    expect(
      fs.existsSync(
        path.join(directory, 'zhihu-minus-minus-v1.2.3-unsigned.ipa'),
      ),
    ).toBe(false);
  });

  test('Release clears inherited Debug bundling flags', () => {
    expect(run({ SKIP_BUNDLING: '1' }).status).toBe(0);
    const trace = fs.readFileSync(path.join(directory, 'trace.txt'), 'utf8');
    expect(trace).toContain('variant= skip=\n');
  });

  test('rejects unknown configurations before modifying native code', () => {
    expect(run({ IOS_BUILD_CONFIGURATION: 'Profile' }).status).not.toBe(0);
    expect(fs.existsSync(path.join(directory, 'trace.txt'))).toBe(false);
  });

  test('rejects ambiguous workspaces or built apps', () => {
    fs.mkdirSync(path.join(directory, 'ios', 'Other.xcworkspace'));
    expect(run().status).not.toBe(0);
    fs.rmSync(path.join(directory, 'ios', 'Other.xcworkspace'), {
      recursive: true,
    });
    expect(run({ IPA_TEST_MULTIPLE_APPS: '1' }).status).not.toBe(0);
    expect(
      fs.existsSync(
        path.join(directory, 'zhihu-minus-minus-v1.2.3-unsigned.ipa'),
      ),
    ).toBe(false);
  });
});
