import { PLATFORM_NAME, PLUGIN_NAME } from './src/constants.js';
import { EnphaseEvChargerPlatform } from './src/platform.js';
import { registerCustomCharacteristics } from './src/custom-characteristics.js';

export default (api) => {
  registerCustomCharacteristics(api);
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EnphaseEvChargerPlatform);
};
