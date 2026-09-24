// The one slice of React Native this entry touches. Declared here so the
// library typechecks without installing react-native; consumers have the real
// types from the package itself.
declare module "react-native" {
  export const AppState: {
    currentState: string;
    addEventListener(type: "change", handler: (state: string) => void): { remove(): void };
  };
}
