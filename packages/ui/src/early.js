// Runs in <head>, before the first paint, on every Weft page. Plain script
// with no imports, meant to be inlined: Shell.astro reads this file and
// inlines it; the docs (Starlight's head) and the explorer (its string
// template) inline the same file, so there is one copy. Nothing in this file
// may spell a closing script tag, since it is inlined.
//
// 1. The theme. A stored choice is applied to the html element's data-theme
//    before the page paints, so it never flashes the other theme. The storage
//    key is data-theme-key on the inlining script tag, "weft-theme" unless
//    said otherwise (the docs use Starlight's key, "starlight-theme").
// 2. The page transition's direction (motion.css). Every navigation is a
//    "forward" view transition unless it goes back through history, when
//    the type is swapped for "back" so the pages move the other way.
(function () {
  var key = (document.currentScript && document.currentScript.dataset.themeKey) || "weft-theme";
  try {
    var t = localStorage.getItem(key);
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}

  var isBack = function (type, from, to) {
    return type === "traverse" && !(from != null && to != null && to > from);
  };
  var goBack = function (transition) {
    transition.types.delete("forward");
    transition.types.add("back");
  };
  addEventListener("pagereveal", function (e) {
    var a = window.navigation && window.navigation.activation;
    if (e.viewTransition && a && isBack(a.navigationType, a.from && a.from.index, a.entry && a.entry.index)) goBack(e.viewTransition);
  });
  addEventListener("pageswap", function (e) {
    var a = e.activation;
    var current = window.navigation && window.navigation.currentEntry;
    if (e.viewTransition && a && isBack(a.navigationType, current && current.index, a.entry && a.entry.index)) goBack(e.viewTransition);
  });
})();
