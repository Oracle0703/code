import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDeb } from '@electron-forge/maker-deb';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'daily-workbench',
    ignore: (filePath) => {
      if (!filePath || filePath === '/package.json' || filePath.startsWith('/.vite')) {
        return false;
      }

      // The Vite main bundle deliberately keeps node-pty external so Forge can
      // rebuild it for Electron's ABI. Preserve its parent traversal and full
      // package; AutoUnpackNativesPlugin moves the native binary out of ASAR.
      if (
        filePath === '/node_modules' ||
        filePath === '/node_modules/node-pty' ||
        filePath.startsWith('/node_modules/node-pty/') ||
        filePath === '/node_modules/node-addon-api' ||
        filePath.startsWith('/node_modules/node-addon-api/')
      ) {
        return false;
      }

      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'DailyWorkbench' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      // node-pty's Windows ConPTY shutdown path uses child_process.fork.
      // Electron must retain RunAsNode for that helper process to work.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
