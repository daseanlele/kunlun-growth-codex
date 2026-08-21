(function () {
  var isSourceFile = !/[\\/]dist[\\/]index\.html$/i.test(decodeURI(window.location.pathname));
  if (window.location.protocol === "file:" && isSourceFile) {
    window.location.replace(new URL("./dist/offline.html", window.location.href).href);
  }
})();
