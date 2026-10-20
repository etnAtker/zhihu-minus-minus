#!/bin/bash

# 遇到任何错误立即退出
set -euo pipefail

# 获取脚本所在目录作为项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

CONFIGURATION="${IOS_BUILD_CONFIGURATION:-Release}"
case "$CONFIGURATION" in
  Debug)
    export APP_VARIANT=development
    # 真机 Debug 默认也会尝试打包 JS；开发客户端改由本地 Metro 提供。
    export SKIP_BUNDLING=1
    ;;
  Release)
    unset SKIP_BUNDLING
    ;;
  *)
    echo "IOS_BUILD_CONFIGURATION 仅支持 Debug 或 Release。"
    exit 1
    ;;
esac

ARTIFACT_DIRECTORY="${IOS_BUILD_ARTIFACTS_DIR:-$PROJECT_ROOT}"
mkdir -p "$ARTIFACT_DIRECTORY"
ARTIFACT_DIRECTORY="$(cd "$ARTIFACT_DIRECTORY" && pwd)"
if [ -n "${IOS_BUILD_ARTIFACTS_DIR:-}" ] && [ "$CONFIGURATION" = Release ]; then
  export SOURCEMAP_FILE="$ARTIFACT_DIRECTORY/main.jsbundle.map"
fi

echo "🚀 [1/3] 开始生成 iOS 原生工程 (Expo Prebuild)..."
# 每次同步配置和本地模块，避免旧生成工程继续链接已移除的依赖。
npx expo prebuild --platform ios --no-install
(cd ios && pod install)

shopt -s nullglob
WORKSPACES=(ios/*.xcworkspace)
if [ "${#WORKSPACES[@]}" -ne 1 ]; then
  echo "需要且只能有一个 iOS workspace，实际找到 ${#WORKSPACES[@]} 个。"
  exit 1
fi
WORKSPACE="${WORKSPACES[0]}"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

echo "📦 [2/3] 开始编译 iOS App 产物 (未签名 $CONFIGURATION)..."
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_NO_UPLOAD=1
xcodebuild -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  SYMROOT="$PROJECT_ROOT/build" \
  DEBUG_INFORMATION_FORMAT=dwarf-with-dsym \
  COMPILER_INDEX_STORE_ENABLE=NO \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  clean build

echo "🗜️ [3/3] 开始打包成 .ipa 文件..."
APP_VERSION=$(node -p "require('./package.json').version")
IPA_NAME="zhihu-minus-minus-v${APP_VERSION}-unsigned.ipa"
if [ "$CONFIGURATION" = Debug ] || [ "${APP_VARIANT:-}" = development ]; then
  BUILD_LABEL="$(printf '%s' "$CONFIGURATION" | tr '[:upper:]' '[:lower:]')"
  IPA_NAME="zhihu-minus-minus-v${APP_VERSION}-dev-${BUILD_LABEL}-unsigned.ipa"
fi

APPS=(build/"$CONFIGURATION"-iphoneos/*.app)
if [ "${#APPS[@]}" -ne 1 ]; then
  echo "需要且只能有一个已编译 App，实际找到 ${#APPS[@]} 个。"
  exit 1
fi

# 只清理本次临时目录；不删除其他版本 IPA 或用户已有的 Payload。
PACKAGE_DIRECTORY="$(mktemp -d "$PROJECT_ROOT/build/ipa.XXXXXX")"
trap 'rm -rf "$PACKAGE_DIRECTORY"' EXIT
mkdir -p "$PACKAGE_DIRECTORY/Payload"
cp -R "${APPS[0]}" "$PACKAGE_DIRECTORY/Payload/"
(cd "$PACKAGE_DIRECTORY" && zip -qr "$IPA_NAME" Payload)
mv "$PACKAGE_DIRECTORY/$IPA_NAME" "$ARTIFACT_DIRECTORY/$IPA_NAME"

if [ -n "${IOS_BUILD_ARTIFACTS_DIR:-}" ]; then
  # 保存本次编译的应用符号，不上传整个 DerivedData 或生成的原生工程。
  if [ ! -d "${APPS[0]}.dSYM" ]; then
    echo "缺少本次构建的应用 dSYM，不能交付可追溯的调试产物。"
    exit 1
  fi
  mkdir -p "$ARTIFACT_DIRECTORY/symbols"
  cp -R "${APPS[0]}.dSYM" "$ARTIFACT_DIRECTORY/symbols/"
  if [ "$CONFIGURATION" = Release ] && [ ! -s "$SOURCEMAP_FILE" ]; then
    echo "缺少本次 Release 构建的 source map。"
    exit 1
  fi

  python3 - "$PROJECT_ROOT" "${APPS[0]}" "$ARTIFACT_DIRECTORY" "$IPA_NAME" "$CONFIGURATION" "$SCHEME" <<'PY'
import hashlib
import json
import os
import pathlib
import plistlib
import subprocess
import sys

root, app, output, ipa_name, configuration, scheme = sys.argv[1:]
artifact_directory = pathlib.Path(output)
with (pathlib.Path(app) / 'Info.plist').open('rb') as source:
    info = plistlib.load(source)

def command(*args):
    return subprocess.check_output(args, cwd=root, text=True).strip()

config = json.loads(command('npx', 'expo', 'config', '--type', 'public', '--json'))
digest = hashlib.sha256()
with (artifact_directory / ipa_name).open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
manifest = {
    'commit': command('git', 'rev-parse', 'HEAD'),
    'sourceFingerprint': config.get('extra', {}).get('diagnostics', {}).get('sourceFingerprint'),
    'configuration': configuration,
    'variant': os.environ.get('APP_VARIANT', 'default'),
    'scheme': scheme,
    'bundleIdentifier': info.get('CFBundleIdentifier'),
    'version': info.get('CFBundleShortVersionString'),
    'buildNumber': info.get('CFBundleVersion'),
    'node': command('node', '--version'),
    'xcode': command('xcodebuild', '-version'),
    'iosSdk': command('xcrun', '--sdk', 'iphoneos', '--show-sdk-version'),
    'cocoaPods': command('pod', '--version'),
    'dsymUuids': command('xcrun', 'dwarfdump', '--uuid', f'{app}.dSYM'),
    'ipa': ipa_name,
    'ipaSha256': digest.hexdigest(),
}
(artifact_directory / 'build-info.json').write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
)
PY
fi

echo "✅ 打包完成！未签名 IPA 生成成功！"
echo "👉 产物路径: $ARTIFACT_DIRECTORY/$IPA_NAME"
