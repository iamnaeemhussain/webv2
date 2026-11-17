/* Pak-Tel's optional Dynaura bridge. A toast failure must never block checkout or navigation. */
(() => {
  let show;
  let pending;
  window.PakTelNotify = (type, title, description) => {
    const options = { title, description, duration: 3200 };
    if (!show) { pending = { type, options }; return; }
    try { show(type, options); } catch { /* Existing inline feedback remains available. */ }
  };

  import('/vendor/dynaura/vanilla.js').then(({ createToaster, dynaura }) => {
    createToaster({ position: 'top', theme: 'dark', haptics: false, queue: false });
    show = (type, options) => (dynaura[type] || dynaura.info)(options);
    window.PakTelNotify.ready = true;
    if (pending) { show(pending.type, pending.options); pending = null; }
  }).catch(() => { pending = null; });
})();
