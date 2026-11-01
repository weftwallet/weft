/* The two parts of a system page (system-page.css) that depend on the
   browser. The address that was asked for: a static host serves one 404 page
   for every address, so the page reads it from its own location, unless the
   server already wrote it in. Go back: shown only when the page before this
   one was on the same site, since going back to another site, or to nothing,
   isn't a next step here. A plain script, inlined right after the page's
   .sys section (SystemPage.astro, and the explorer's pages.ts), so both are
   in place before the first paint. */
(function () {
  var pages = document.querySelectorAll(".sys");
  var page = pages[pages.length - 1];
  if (!page) return;

  var address = page.querySelector("[data-sys-address]");
  if (address) {
    if (!address.textContent) {
      var path = location.pathname;
      try {
        path = decodeURI(path);
      } catch (e) {
        /* keep it encoded */
      }
      address.textContent = location.host + path + location.search;
    }
    address.closest(".sys__addr").hidden = false;
  }

  var back = page.querySelector("[data-sys-back]");
  if (!back) return;
  // The Navigation API lists this tab's entries on this origin only, so an
  // entry before this one is a page on this site. Without it, the referrer
  // says where the person came from, when the site sends one.
  var entry = window.navigation && window.navigation.currentEntry;
  var fromHere = false;
  if (entry) fromHere = entry.index > 0;
  else {
    try {
      fromHere = new URL(document.referrer).origin === location.origin;
    } catch (e) {
      fromHere = false;
    }
  }
  if (!fromHere) return;
  back.hidden = false;
  back.addEventListener("click", function () {
    history.back();
  });
})();
