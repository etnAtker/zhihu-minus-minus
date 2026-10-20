import type { ConfigContext, ExpoConfig } from 'expo/config';
import configure from '../app.config';
import app from '../app.json';

const baseConfig = app.expo as ExpoConfig;

function resolveConfig(): ExpoConfig {
  return configure({ config: baseConfig } as ConfigContext);
}

beforeEach(() => {
  jest.replaceProperty(process, 'env', { ...process.env });
  delete process.env.APP_VARIANT;
  delete process.env.IOS_DEBUG_BUNDLE_ID;
});

afterEach(() => jest.restoreAllMocks());

test('default identity and transport permissions remain those of the base app', () => {
  process.env.IOS_DEBUG_BUNDLE_ID = 'com.example.ignored';
  const config = resolveConfig();
  expect(config.name).toBe(baseConfig.name);
  expect(config.slug).toBe(baseConfig.slug);
  expect(config.scheme).toBe(baseConfig.scheme);
  expect(config.ios?.bundleIdentifier).toBe(baseConfig.ios?.bundleIdentifier);
  expect(config.ios?.infoPlist).toEqual(baseConfig.ios?.infoPlist);
});

test('development variant has a separate identity and can connect to LAN Metro', () => {
  process.env.APP_VARIANT = 'development';
  const config = resolveConfig();
  expect(config.name).toBe(`${baseConfig.name} 调试`);
  expect(config.slug).toBe(`${baseConfig.slug}-dev`);
  expect(config.scheme).toBe('zhihu-minus-minus-dev');
  expect(config.ios?.bundleIdentifier).toBe(
    `${baseConfig.ios?.bundleIdentifier}.dev`,
  );
  expect(config.ios?.infoPlist).toMatchObject({
    ...baseConfig.ios?.infoPlist,
    NSLocalNetworkUsageDescription: expect.any(String),
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: true,
      NSAllowsLocalNetworking: true,
    },
  });
  expect(config.android).toMatchObject(baseConfig.android ?? {});
});

test('development bundle identifier can be kept consistent with a signing setup', () => {
  process.env.APP_VARIANT = 'development';
  process.env.IOS_DEBUG_BUNDLE_ID = 'com.example.zhihu.dev';
  expect(resolveConfig().ios?.bundleIdentifier).toBe('com.example.zhihu.dev');
});
