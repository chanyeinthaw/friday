import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'

import { FRIDAY_CONFIG_PATH } from '../FridayHome.ts'
import { loadAppConfig, type AppConfig as AppConfigData } from './AppConfig.ts'

export class AppConfig extends Context.Service<AppConfig, AppConfigData>()(
  'friday/config/AppConfig',
) {}

export const AppConfigLive = Layer.effect(
  AppConfig,
  loadAppConfig({ path: FRIDAY_CONFIG_PATH }),
).pipe(Layer.provideMerge(BunFileSystem.layer))
