// Stand-ins for the modules the single-file demo never uses (Privy, the HTTP backend, bundled fonts).
import type { Api } from '../src/lib/types';
export const httpApi = {} as Api;
export default function PrivyAuthProvider() { return null; }
