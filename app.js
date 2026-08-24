(() => {
  const { Dogs, Entries, Photos, Weights } = window.DB;
  const H = window.Helpers;

  // ---- In-memory state ----
  let dogs = [];
  let currentDogId = localStorage.getItem('pawbook_currentDogId') || null;
  let activeTab = 'timeline';
  let pendingPhotos = []; // [{thumbBlob, fullBlob, previewUrl}] for the entry sheet in progress
  let editingDogId = null; // set when the dog sheet is in "edit" mode

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const dogSwitcherEl = $('#dogSwitcher');
  const screens = { timeline: $('#screen-timeline'), weight: $('#screen-weight'), profile: $('#screen-profile') };
  const tabBtns = $$('.tab-btn');
  const fab = $('#fab');
  const toastEl = $('#toast');

  // ================= Utilities =================

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function openSheet(sheetEl) {
    $('#sheetBackdrop').classList.add('open');
    sheetEl.classList.add('open');
  }

  function closeSheet(sheetEl) {
    sheetEl.classList.remove('open');
    // Only drop the backdrop once nothing else is open.
    if (!$$('.sheet.open').length) $('#sheetBackdrop').classList.remove('open');
  }

  function closeAllSheets() {
    $$('.sheet').forEach(closeSheet);
  }

  function currentDog() {
    return dogs.find((d) => d.id === currentDogId) || null;
  }

  function objectUrlFor(blob) {
    return blob ? URL.createObjectURL(blob) : '';
  }

  // ================= Boot =================

  async function boot() {
    dogs = await Dogs.all();

    if (!dogs.length) {
      showOnboarding();
      return;
    }

    if (!currentDogId || !dogs.some((d) => d.id === currentDogId)) {
      currentDogId = dogs[0].id;
    }
    persistCurrentDog();

    renderDogSwitcher();
    setTab('timeline');
    wireEvents();
  }

  function persistCurrentDog() {
    if (currentDogId) localStorage.setItem('pawbook_currentDogId', currentDogId);
  }

  function showOnboarding() {
    wireEvents();
    editingDogId = null;
    $('#dogSheetTitle').textContent = 'Add your first dog';
    $('#dogSheetDelete').style.display = 'none';
    resetDogForm();
    openSheet($('#dogSheet'));
  }

  // ================= Tabs =================

  function setTab(tab) {
    activeTab = tab;
    Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === tab));
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    fab.style.display = tab === 'timeline' ? 'flex' : 'none';
    render();
  }

  // ================= Dog switcher =================

  function renderDogSwitcher() {
    dogSwitcherEl.innerHTML = '';
    dogs.forEach((dog) => {
      const chip = document.createElement('button');
      chip.className = 'dog-chip' + (dog.id === currentDogId ? ' active' : '');
      chip.innerHTML = `<span class="avatar">${dog.coverPhotoUrl ? `<img src="${dog.coverPhotoUrl}" alt="">` : initials(dog.name)}</span>${escapeHtml(dog.name)}`;
      chip.addEventListener('click', () => {
        currentDogId = dog.id;
        persistCurrentDog();
        renderDogSwitcher();
        render();
      });
      dogSwitcherEl.appendChild(chip);
    });

    const addChip = document.createElement('button');
    addChip.className = 'dog-chip add';
    addChip.textContent = '+ Add dog';
    addChip.addEventListener('click', () => {
      editingDogId = null;
      $('#dogSheetTitle').textContent = 'Add a dog';
      $('#dogSheetDelete').style.display = 'none';
      resetDogForm();
      openSheet($('#dogSheet'));
    });
    dogSwitcherEl.appendChild(addChip);
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ================= Render dispatch =================

  async function render() {
    if (!currentDog()) return;
    if (activeTab === 'timeline') await renderTimeline();
    if (activeTab === 'weight') await renderWeight();
    if (activeTab === 'profile') await renderProfile();
  }

  // ================= Timeline =================

  async function renderTimeline() {
    const root = $('#screen-timeline');
    const entries = await Entries.forDog(currentDogId);

    if (!entries.length) {
      root.innerHTML = emptyStateHtml('🐾', 'No entries yet', 'Tap the + button to add your first photo or memory.');
      return;
    }

    const today = H.todayLocalStr();
    const onThisDay = H.onThisDayEntries(entries, today);
    const groups = H.groupEntriesByMonth(entries);

    let html = '';
    if (onThisDay.length) {
      const years = onThisDay.map((e) => H.parseLocalDate(e.date).getFullYear()).join(', ');
      html += `<div class="on-this-day"><div>
          <div class="label">On this day</div>
          <div class="text">${onThisDay.length} ${onThisDay.length === 1 ? 'memory' : 'memories'} from ${years}</div>
        </div></div>`;
    }

    for (const group of groups) {
      html += `<div class="month-heading">${group.label}</div>`;
      for (const entry of group.entries) {
        html += await entryCardHtml(entry);
      }
    }

    root.innerHTML = html;

    // Wire favorite buttons after paint.
    $$('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const entry = entries.find((en) => en.id === id);
        entry.favorite = !entry.favorite;
        await Entries.update(entry);
        btn.classList.toggle('active', entry.favorite);
        btn.textContent = entry.favorite ? '♥' : '♡';
      });
    });
  }

  async function entryCardHtml(entry) {
    const photoRecords = await Promise.all((entry.photoIds || []).map((id) => Photos.get(id)));
    const validPhotos = photoRecords.filter(Boolean);

    let photosHtml = '';
    if (validPhotos.length) {
      const n = validPhotos.length === 1 ? 'n1' : validPhotos.length === 2 ? 'n2' : 'nmany';
      photosHtml = `<div class="entry-photos ${n}">${validPhotos
        .slice(0, 4)
        .map((p) => `<img src="${objectUrlFor(p.thumbBlob)}" alt="">`)
        .join('')}</div>`;
    }

    const tagsHtml = entry.tags && entry.tags.length
      ? `<div class="tags">${entry.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    return `
      <div class="entry-card ${entry.type === 'milestone' ? 'milestone' : ''}">
        <div class="date-stamp">${H.formatDateShort(entry.date)}${entry.type === 'milestone' ? ' · milestone' : ''}</div>
        ${photosHtml}
        <div class="entry-body">
          ${entry.caption ? `<p class="caption">${escapeHtml(entry.caption)}</p>` : ''}
          <div class="meta">
            <span>${H.formatDateLong(entry.date)}</span>
            <button class="fav-btn ${entry.favorite ? 'active' : ''}" data-id="${entry.id}">${entry.favorite ? '♥' : '♡'}</button>
          </div>
          ${tagsHtml}
        </div>
      </div>`;
  }

  function emptyStateHtml(paw, title, body) {
    return `<div class="empty-state"><div class="paw">${paw}</div><h2>${title}</h2><p>${body}</p></div>`;
  }

  // ================= Weight =================

  async function renderWeight() {
    const root = $('#screen-weight');
    const weights = await Weights.forDog(currentDogId);

    if (!weights.length) {
      root.innerHTML =
        emptyStateHtml('⚖️', 'No weigh-ins yet', 'Log a weight to start tracking trends over time.') +
        `<button class="btn btn-primary btn-block" id="addFirstWeight">Log a weight</button>`;
      $('#addFirstWeight').addEventListener('click', () => openWeightSheet());
      return;
    }

    const latest = weights[weights.length - 1];
    const prev = weights.length > 1 ? weights[weights.length - 2] : null;
    const delta = prev ? latest.weightKg - prev.weightKg : null;
    const all = weights.map((w) => w.weightKg);
    const min = Math.min(...all);
    const max = Math.max(...all);

    const chart = H.buildWeightChartPoints(weights, 320, 140, 24);

    let svg = '';
    if (chart) {
      svg = `<svg viewBox="0 0 320 140">
        <path class="chart-line" d="${chart.path}" />
        ${chart.points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="3.5" />`).join('')}
        <text class="chart-axis-label" x="24" y="134">${H.formatDateShort(weights[0].date)}</text>
        <text class="chart-axis-label" x="296" y="134" text-anchor="end">${H.formatDateShort(weights[weights.length - 1].date)}</text>
      </svg>`;
    }

    root.innerHTML = `
      <div class="weight-summary">
        <div class="stat-card">
          <div class="value">${latest.weightKg.toFixed(1)}<span style="font-size:13px">kg</span></div>
          <div class="label">Current</div>
          ${delta !== null ? `<div class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg</div>` : ''}
        </div>
        <div class="stat-card">
          <div class="value">${min.toFixed(1)}–${max.toFixed(1)}</div>
          <div class="label">Range (kg)</div>
        </div>
      </div>
      <div class="chart-card">${svg}</div>
      <button class="btn btn-primary btn-block" id="addWeightBtn" style="margin-bottom:16px;">+ Log weight</button>
      <div id="weightList"></div>
    `;

    const listEl = $('#weightList');
    [...weights].reverse().forEach((w) => {
      const row = document.createElement('div');
      row.className = 'weight-row';
      row.innerHTML = `
        <div>
          <div class="w-date">${H.formatDateLong(w.date)}</div>
          ${w.note ? `<div class="w-note">${escapeHtml(w.note)}</div>` : ''}
        </div>
        <div class="w-val">${w.weightKg.toFixed(1)} kg <span style="color:var(--ink-soft);font-weight:400;">(${H.kgToLb(w.weightKg).toFixed(1)} lb)</span></div>
      `;
      listEl.appendChild(row);
    });

    $('#addWeightBtn').addEventListener('click', () => openWeightSheet());
  }

  function openWeightSheet() {
    $('#weightDate').value = H.todayLocalStr();
    $('#weightKg').value = '';
    $('#weightNote').value = '';
    openSheet($('#weightSheet'));
  }

  // ================= Profile =================

  async function renderProfile() {
    const root = $('#screen-profile');
    const dog = currentDog();
    if (!dog) return;

    const entries = await Entries.forDog(currentDogId);
    const milestones = entries.filter((e) => e.type === 'milestone' || e.favorite);
    const age = dog.birthday ? H.calcAge(dog.birthday) : null;

    let milestonesHtml = '';
    if (milestones.length) {
      milestonesHtml = `<div class="month-heading">Milestones &amp; favorites</div>`;
      for (const entry of milestones) {
        milestonesHtml += await entryCardHtml(entry);
      }
    }

    root.innerHTML = `
      <div class="dog-hero">
        <div class="avatar-lg">${dog.coverPhotoUrl ? `<img src="${dog.coverPhotoUrl}" alt="">` : initials(dog.name)}</div>
        <h2>${escapeHtml(dog.name)}</h2>
        <div class="sub">${[dog.breed, age ? H.formatAge(age) : null].filter(Boolean).join(' · ') || 'Add breed & birthday'}</div>
      </div>
      <div class="profile-actions">
        <button class="btn btn-secondary" style="flex:1" id="editDogBtn">Edit profile</button>
      </div>
      ${milestonesHtml}
    `;

    $('#editDogBtn').addEventListener('click', () => {
      editingDogId = dog.id;
      $('#dogSheetTitle').textContent = 'Edit profile';
      $('#dogSheetDelete').style.display = dogs.length > 1 ? 'block' : 'none';
      $('#dogName').value = dog.name || '';
      $('#dogBreed').value = dog.breed || '';
      $('#dogBirthday').value = dog.birthday || '';
      openSheet($('#dogSheet'));
    });
  }

  // ================= Dog sheet (add/edit) =================

  function resetDogForm() {
    $('#dogName').value = '';
    $('#dogBreed').value = '';
    $('#dogBirthday').value = '';
  }

  async function saveDog() {
    const name = $('#dogName').value.trim();
    if (!name) {
      showToast('Give your dog a name first');
      return;
    }
    const breed = $('#dogBreed').value.trim();
    const birthday = $('#dogBirthday').value || null;

    if (editingDogId) {
      const dog = dogs.find((d) => d.id === editingDogId);
      dog.name = name;
      dog.breed = breed;
      dog.birthday = birthday;
      await Dogs.update(dog);
    } else {
      const dog = await Dogs.add({ name, breed, birthday });
      dogs.push(dog);
      currentDogId = dog.id;
      persistCurrentDog();
    }

    closeSheet($('#dogSheet'));
    renderDogSwitcher();
    setTab(activeTab === 'profile' || dogs.length === 1 ? 'timeline' : activeTab);
    showToast('Saved');
  }

  async function deleteDog() {
    if (!editingDogId) return;
    if (!confirm('Delete this dog and all their entries? This can\'t be undone.')) return;

    const entries = await Entries.forDog(editingDogId);
    for (const e of entries) await Entries.remove(e.id);
    const weights = await Weights.forDog(editingDogId);
    for (const w of weights) await Weights.remove(w.id);
    await Dogs.remove(editingDogId);

    dogs = dogs.filter((d) => d.id !== editingDogId);
    if (currentDogId === editingDogId) currentDogId = dogs.length ? dogs[0].id : null;
    persistCurrentDog();
    closeSheet($('#dogSheet'));

    if (!dogs.length) {
      showOnboarding();
    } else {
      renderDogSwitcher();
      setTab('timeline');
    }
  }

  // ================= Entry sheet (add) =================

  function resetEntryForm() {
    $('#entryDate').value = H.todayLocalStr();
    $('#entryCaption').value = '';
    $('#entryTags').value = '';
    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    pendingPhotos = [];
    renderPhotoPicker();
    $$('.type-toggle button').forEach((b) => b.classList.toggle('selected', b.dataset.type === 'photo'));
    $('#entrySheet').dataset.type = 'photo';
  }

  function renderPhotoPicker() {
    const wrap = $('#photoPicker');
    wrap.innerHTML = '';
    pendingPhotos.forEach((p, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.innerHTML = `<img src="${p.previewUrl}" alt=""><button class="remove" data-i="${i}">×</button>`;
      wrap.appendChild(thumb);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'add-photo';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.id = 'addPhotoBtn';
    wrap.appendChild(addBtn);

    // iOS requires the file input to be opened synchronously from the tap.
    addBtn.addEventListener('click', () => $('#photoInput').click());

    $$('.thumb .remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        URL.revokeObjectURL(pendingPhotos[i].previewUrl);
        pendingPhotos.splice(i, 1);
        renderPhotoPicker();
      });
    });
  }

  async function handlePhotoSelection(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    showToast('Processing photo' + (files.length > 1 ? 's' : '') + '…');
    for (const file of files) {
      try {
        const { thumbBlob, fullBlob } = await window.Media.processPhoto(file);
        pendingPhotos.push({ thumbBlob, fullBlob, previewUrl: objectUrlFor(thumbBlob) });
      } catch (err) {
        console.error('Photo processing failed', err);
        showToast('Could not process that photo');
      }
    }
    renderPhotoPicker();
  }

  async function saveEntry() {
    const type = $('#entrySheet').dataset.type || 'photo';
    const date = $('#entryDate').value || H.todayLocalStr();
    const caption = $('#entryCaption').value.trim();
    const tags = $('#entryTags').value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    if (type === 'photo' && !pendingPhotos.length && !caption) {
      showToast('Add a photo or a note first');
      return;
    }
    if (type !== 'photo' && !caption) {
      showToast('Write a note first');
      return;
    }

    const photoIds = [];
    for (const p of pendingPhotos) {
      const rec = await Photos.add({ thumbBlob: p.thumbBlob, fullBlob: p.fullBlob });
      photoIds.push(rec.id);
    }

    await Entries.add({ dogId: currentDogId, date, type, caption, photoIds, tags });

    closeSheet($('#entrySheet'));
    showToast('Added to timeline');
    if (activeTab === 'timeline') renderTimeline();
  }

  // ================= Wire events =================

  let wired = false;
  function wireEvents() {
    if (wired) return;
    wired = true;

    tabBtns.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

    fab.addEventListener('click', () => {
      resetEntryForm();
      openSheet($('#entrySheet'));
    });

    $$('.type-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.type-toggle button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        $('#entrySheet').dataset.type = btn.dataset.type;
      });
    });

    $('#photoInput').addEventListener('change', (e) => {
      handlePhotoSelection(e.target.files);
      e.target.value = ''; // allow picking the same file again later
    });

    $('#sheetBackdrop').addEventListener('click', closeAllSheets);
    $$('.sheet-close').forEach((btn) =>
      btn.addEventListener('click', () => closeSheet(btn.closest('.sheet')))
    );

    $('#saveEntryBtn').addEventListener('click', saveEntry);
    $('#saveDogBtn').addEventListener('click', saveDog);
    $('#dogSheetDelete').addEventListener('click', deleteDog);
    $('#saveWeightBtn').addEventListener('click', async () => {
      const date = $('#weightDate').value || H.todayLocalStr();
      const kg = parseFloat($('#weightKg').value);
      if (!kg || kg <= 0) {
        showToast('Enter a valid weight');
        return;
      }
      await Weights.add({ dogId: currentDogId, date, weightKg: kg, note: $('#weightNote').value.trim() });
      closeSheet($('#weightSheet'));
      showToast('Weight logged');
      if (activeTab === 'weight') renderWeight();
    });
  }

  // ================= Service worker =================

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
