import { usePushRegistration } from './useRegistration';

/** Renders nothing; registers this device for push when signed in. */
export function PushRegistration(): null {
  usePushRegistration();
  return null;
}
