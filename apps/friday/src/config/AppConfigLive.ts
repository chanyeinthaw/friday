import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { loadAppConfig, type AppConfig as AppConfigData } from './AppConfig.ts'
import { runMigrations } from '../persistence/Migrations.ts'

export class AppConfig extends Context.Service<AppConfig, AppConfigData>()(
  'friday/config/AppConfig',
) {}

export const AppConfigLive = Layer.effect(
  AppConfig,
  runMigrations().pipe(Effect.andThen(loadAppConfig())),
)
