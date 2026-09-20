// Stand-ins for the modules the single-file demo never uses (Privy, the HTTP backend, bundled fonts).
import type { Api } from '@vouch/shared';
export const httpApi = {} as Api;
export default function PrivyAuthProvider() { return null; }
