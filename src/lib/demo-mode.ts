// Module-level only, never stored, so a reload always starts outside demo mode.
let demoMode = false;

export const isDemoMode = () => demoMode;
export const setDemoMode = (on: boolean) => { demoMode = on; };
