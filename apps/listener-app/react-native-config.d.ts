/**
 * Typed surface for the values react-native-config bakes in from `.env.*`.
 * Keeping this beside the app gives autocompletion and stops typos in key names
 * (`Config.API_BASE_URl` etc.) from slipping through.
 */
declare module 'react-native-config' {
  export interface NativeConfig {
    API_BASE_URL?: string;
    STREAM_BASE_URL?: string;
    SUPABASE_URL?: string;
    SUPABASE_ANON_KEY?: string;
    SENTRY_DSN?: string;
  }

  export const Config: NativeConfig;
  export default Config;
}
