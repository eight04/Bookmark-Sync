export const USER_AGENT = navigator.userAgent.match(/Firefox/) ? "firefox" : "chrome";

export const builtinIds = {
  // root: {
  //   chrome: "0",
  //   firefox: "root________"
  // },
  toolbar: {
    chrome: null,
    firefox: "toolbar_____",
  },
  other: {
    chrome: null,
    firefox: "unfiled_____",
  },
  mobile: {
    chrome: null,
    firefox: "mobile______",
  },
  menu: {
    chrome: null,
    firefox: "menu________",
  }
}

export const NATIVE_ID = Symbol();

