// Campaignia site analytics loader.
// Google Analytics 4 (GA4). Loads ONLY on the production campaignia.com host so that
// chroniclemygame.com, the staging URL, and localhost never send data. Public pages only
// (landing, Library, shared story pages) -- never the signed-in app.
(function () {
  var h = (location.hostname || "").toLowerCase();
  if (h !== "campaignia.com" && h !== "www.campaignia.com") return;
  var GA_ID = "G-NBD735Z84Y";
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID);
})();
