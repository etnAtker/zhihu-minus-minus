import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

const SOURCE_ROOTS = [
  'app',
  'components',
  'hooks',
  'utils',
  'api',
  'features',
  'storage',
  'store',
  'modules',
  'types',
  'constants',
] as const;
const EXCLUDED_DIRECTORIES = new Set([
  'fixtures',
  'tests',
  '__tests__',
  '__mocks__',
  'assets',
  'node_modules',
  'build',
  'dist',
  'vendor',
]);

function isSourceSegment(segment: string): boolean {
  return (
    !segment.startsWith('.') &&
    /^[\w()[\]+.-]+$/.test(segment) &&
    !EXCLUDED_DIRECTORIES.has(segment) &&
    !/(?:^|[._-])(?:config|env|secrets?|credentials?)(?:[._-]|$)/i.test(segment)
  );
}

interface DiagnosticsManifest {
  commit?: string;
  sourceFingerprint?: string;
  sourceFiles?: string[];
}

/** Only publish source paths and content hashes, never file contents or paths outside the repo. */
export function createDiagnosticsManifest(root: string): DiagnosticsManifest {
  const manifest: DiagnosticsManifest = {};
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[a-f0-9]{40}$/i.test(commit)) manifest.commit = commit.toLowerCase();
  } catch {
    // Source archives and EAS uploads need not contain Git metadata.
  }

  try {
    const files: string[] = [];
    function visit(relative: string): void {
      const absolute = join(root, relative);
      if (!existsSync(absolute)) return;
      const stat = lstatSync(absolute);
      // Never follow symlinks: source paths cannot grant access outside the repo.
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of readdirSync(absolute).sort()) {
          if (isSourceSegment(name)) visit(`${relative}/${name}`);
        }
      } else if (
        stat.isFile() &&
        relative.length <= 240 &&
        /\.(?:[cm]?jsx?|tsx?|swift|m|mm|h|java|kt)$/.test(relative) &&
        !/\.(?:test|spec)\.[^/]+$/.test(relative)
      ) {
        files.push(relative);
      }
    }
    for (const directory of SOURCE_ROOTS) visit(directory);
    if (files.length > 0) {
      const hash = createHash('sha256');
      for (const file of files.sort()) {
        const contents = readFileSync(join(root, file));
        hash.update(`${file}\0${contents.length}\0`);
        hash.update(contents);
      }
      manifest.sourceFiles = files;
      manifest.sourceFingerprint = hash.digest('hex').slice(0, 24);
    }
  } catch {
    // Diagnostics must not prevent configuration/builds if source access fails.
  }
  return manifest;
}

const firebasePluginNames = new Set([
  '@react-native-firebase/app',
  '@react-native-firebase/analytics',
]);

function existingPath(value: string | undefined): string | undefined {
  return value && existsSync(value) ? value : undefined;
}

function withoutFirebasePlugins(
  plugins: ExpoConfig['plugins'],
): ExpoConfig['plugins'] {
  return plugins?.filter((plugin) => {
    const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
    return (
      typeof pluginName !== 'string' || !firebasePluginNames.has(pluginName)
    );
  });
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const baseConfig = config as ExpoConfig;
  const developmentVariant = process.env.APP_VARIANT === 'development';
  const firebaseAnalyticsEnabled =
    process.env.EXPO_PUBLIC_FIREBASE_ANALYTICS_ENABLED === 'true';
  const androidGoogleServicesFile = existingPath(
    process.env.GOOGLE_SERVICES_JSON,
  );
  const iosGoogleServicesFile = existingPath(
    process.env.GOOGLE_SERVICE_INFO_PLIST,
  );

  return {
    ...baseConfig,
    name: developmentVariant ? `${baseConfig.name} 调试` : baseConfig.name,
    ...(developmentVariant
      ? {
          slug: `${baseConfig.slug}-dev`,
          scheme: 'zhihu-minus-minus-dev',
        }
      : {}),
    plugins: firebaseAnalyticsEnabled
      ? baseConfig.plugins
      : withoutFirebasePlugins(baseConfig.plugins),
    android: {
      ...baseConfig.android,
      ...(developmentVariant
        ? { package: `${baseConfig.android?.package}.dev` }
        : {}),
      ...(androidGoogleServicesFile
        ? { googleServicesFile: androidGoogleServicesFile }
        : {}),
    },
    ios: {
      ...baseConfig.ios,
      ...(developmentVariant
        ? {
            bundleIdentifier:
              process.env.IOS_DEBUG_BUNDLE_ID ||
              `${baseConfig.ios?.bundleIdentifier}.dev`,
            infoPlist: {
              ...baseConfig.ios?.infoPlist,
              NSLocalNetworkUsageDescription:
                '允许连接电脑上的 Metro 开发服务器以调试应用。',
              NSAppTransportSecurity: {
                ...baseConfig.ios?.infoPlist?.NSAppTransportSecurity,
                NSAllowsArbitraryLoads: true,
                NSAllowsLocalNetworking: true,
              },
            },
          }
        : {}),
      ...(iosGoogleServicesFile
        ? { googleServicesFile: iosGoogleServicesFile }
        : {}),
    },
    extra: {
      ...baseConfig.extra,
      diagnostics: createDiagnosticsManifest(__dirname),
      firebaseAnalyticsEnabled,
      ...(process.env.EXPO_PUBLIC_SENTRY_DSN
        ? { sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN }
        : {}),
    },
  };
};
