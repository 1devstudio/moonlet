// App state kept in the webview's localStorage under `moonlet.<name>`. Until
// the app saves a value, the one jaunt wrote under `jaunt.<name>` is read
// instead (X27).

export function readStored(name: string): string | null {
  return localStorage.getItem(`moonlet.${name}`) ?? localStorage.getItem(`jaunt.${name}`);
}

export function writeStored(name: string, value: string) {
  localStorage.setItem(`moonlet.${name}`, value);
}
