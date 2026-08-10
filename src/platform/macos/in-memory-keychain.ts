import type {
  CredentialStore,
} from "../../features/onboarding/index.js";
import { validateCredentialName } from "../../features/onboarding/index.js";

export function createInMemoryCredentialStore(): CredentialStore {
  const values = new Map<ReturnType<typeof validateCredentialName>, string>();
  return {
    read(name) {
      return Promise.resolve(values.get(validateCredentialName(name)));
    },
    write(name, value) {
      validateCredentialName(name);
      values.set(name, value);
      return Promise.resolve();
    },
    remove(name) {
      values.delete(validateCredentialName(name));
      return Promise.resolve();
    },
  };
}
