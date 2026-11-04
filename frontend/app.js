const DEFAULT_CITY = { name: 'Алматы', latitude: 43.2389, longitude: 76.8897, zoom: 12 };
let selectedCity = { ...DEFAULT_CITY };
const map = L.map('map', { zoomControl: false }).setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const routeLayer = L.featureGroup().addTo(map);
const greenLayer = L.layerGroup().addTo(map);
const heatLayer = L.layerGroup().addTo(map);
const waterLayer = L.layerGroup().addTo(map);
let routeData = null;
let activeRoute = 'cool';
let transportMode = 'foot';
let mapSelectionMode = null;
let startPoint = null;
let endPoint = null;
let reportTarget = null;
let toastTimer;
let cityDataRevision = 0;
let routeRequestRevision = 0;

const $ = (id) => document.getElementById(id);
const startInput = $('startInput');
const endInput = $('endInput');
const routeButton = $('routeButton');
const routeError = $('routeError');
const cityPicker = $('cityPicker');
const cityButton = $('cityButton');
const citySearchInput = $('citySearchInput');
const citySearchStatus = $('citySearchStatus');
const citySearchResults = $('citySearchResults');
const locateButton = $('locateButton');
const locationStatus = $('locationStatus');

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'Сервер вернул ответ в неподдерживаемом формате.'
        : `Сервис временно недоступен (ошибка ${response.status}).`,
    );
  }
  if (!response.ok) throw new Error(payload.detail || 'Не удалось выполнить запрос.');
  return payload;
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function updateCityLabels() {
  $('cityLabel').textContent = selectedCity.name;
  $('mapCityLabel').textContent = selectedCity.name;
}

function preferredSearchLanguage() {
  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  return languages.filter(Boolean).join(',').slice(0, 100);
}

function refreshCityData() {
  cityDataRevision += 1;
  greenLayer.clearLayers();
  heatLayer.clearLayers();
  waterLayer.clearLayers();
  $('temperatureValue').textContent = '—°';
  $('feelsLike').textContent = 'Загружаем погоду…';
  document.querySelector('.heat-meter > span').style.width = '0%';
  $('reportCount').textContent = '0';
  $('hotspotList').innerHTML = '<span class="empty-hotspots">Загружаем отметки…</span>';
  loadWeather(cityDataRevision);
  loadPlaces(cityDataRevision);
  loadReports(cityDataRevision);
  loadInsights(cityDataRevision);
}

function closeCityPicker() {
  cityPicker.hidden = true;
  cityButton.setAttribute('aria-expanded', 'false');
}

function selectCity(city) {
  selectedCity = {
    name: city.name,
    latitude: Number(city.latitude),
    longitude: Number(city.longitude),
    zoom: 13,
  };
  updateCityLabels();
  closeCityPicker();
  citySearchInput.value = '';
  citySearchResults.replaceChildren();
  citySearchStatus.textContent = 'Город выбран.';
  invalidateRouteData();
  startPoint = null;
  endPoint = null;
  startInput.value = '';
  endInput.value = '';
  startInput.dataset.resolvedName = '';
  endInput.dataset.resolvedName = '';
  map.setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
  setMapMode(null);
  locationStatus.textContent = '';
  locationStatus.classList.remove('error');
  refreshCityData();
  showToast(`Карта обновлена: ${selectedCity.name}`);
}

async function searchCities(event) {
  event.preventDefault();
  const query = citySearchInput.value.trim();
  if (query.length < 2) {
    citySearchStatus.textContent = 'Введите не менее двух символов.';
    return;
  }
  const searchButton = $('citySearchButton');
  searchButton.disabled = true;
  citySearchStatus.textContent = 'Ищем город…';
  citySearchResults.replaceChildren();
  try {
    const parameters = new URLSearchParams({
      q: query,
      language: preferredSearchLanguage(),
    });
    const results = await api(`/api/cities?${parameters}`);
    if (!results.length) {
      citySearchStatus.textContent = 'Город не найден. Проверьте название и попробуйте ещё раз.';
      return;
    }
    citySearchStatus.textContent = 'Выберите город из списка:';
    const entries = results.map((city) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('strong');
      name.textContent = city.name;
      const details = document.createElement('small');
      details.textContent = city.display_name;
      button.append(name, details);
      button.addEventListener('click', () => selectCity(city));
      item.append(button);
      return item;
    });
    citySearchResults.replaceChildren(...entries);
  } catch (error) {
    citySearchStatus.textContent = error.message;
  } finally {
    searchButton.disabled = false;
  }
}

function markerIcon(label, isEnd = false) {
  return L.divIcon({
    className: '',
    html: `<span class="route-marker${isEnd ? ' end' : ''}">${label}</span>`,
    iconSize: [25, 25],
    iconAnchor: [12, 12],
  });
}

function setPoint(type, latlng, label) {
  const point = { latitude: latlng.lat, longitude: latlng.lng };
  if (type === 'start') {
    startPoint = point;
    startInput.value = label || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    startInput.dataset.resolvedName = label || '';
  } else {
    endPoint = point;
    endInput.value = label || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    endInput.dataset.resolvedName = label || '';
  }
  invalidateRouteData();
  drawRoutePoints();
}

function invalidateRouteData() {
  routeRequestRevision += 1;
  routeData = null;
  activeRoute = 'cool';
  routeLayer.clearLayers();
  $('routeResults').hidden = true;
  routeButton.disabled = false;
  $('footMode').disabled = false;
  $('bikeMode').disabled = false;
  routeButton.querySelector('span').textContent = 'Найти прохладный путь';
}

function clearRouteDisplay() {
  routeData = null;
  activeRoute = 'cool';
  routeLayer.clearLayers();
  $('routeResults').hidden = true;
}

function drawRoutePoints() {
  routeLayer.eachLayer((layer) => {
    if (layer.options && layer.options.pointMarker) routeLayer.removeLayer(layer);
  });
  if (startPoint) {
    const marker = L.marker([startPoint.latitude, startPoint.longitude], { icon: markerIcon('A'), draggable: true });
    marker.options.pointMarker = true;
    marker.on('dragend', (event) => {
      const location = event.target.getLatLng();
      startPoint = { latitude: location.lat, longitude: location.lng };
      startInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
      invalidateRouteData();
      drawRoutePoints();
    });
    routeLayer.addLayer(marker);
  }
  if (endPoint) {
    const marker = L.marker([endPoint.latitude, endPoint.longitude], { icon: markerIcon('Б', true), draggable: true });
    marker.options.pointMarker = true;
    marker.on('dragend', (event) => {
      const location = event.target.getLatLng();
      endPoint = { latitude: location.lat, longitude: location.lng };
      endInput.value = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
      invalidateRouteData();
      drawRoutePoints();
    });
    routeLayer.addLayer(marker);
  }
}

function parseCoordinates(value) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) {
    return { latitude: first, longitude: second };
  }
  return null;
}

async function resolveLocation(input, currentPoint) {
  const coordinates = parseCoordinates(input.value);
  if (coordinates) return coordinates;
  if (currentPoint && input.value.trim() === input.dataset.resolvedName) return currentPoint;
  const parameters = new URLSearchParams({
    q: input.value.trim(),
    language: preferredSearchLanguage(),
  });
  const results = await api(`/api/geocode?${parameters}`);
  if (!results.length) throw new Error(`Не удалось найти адрес «${input.value.trim()}». Попробуйте указать более точное место.`);
  const place = results[0];
  input.value = place.name.split(',').slice(0, 3).join(', ');
  input.dataset.resolvedName = input.value;
  return { latitude: Number(place.latitude), longitude: Number(place.longitude) };
}

function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(meters)} м`;
}

function formatTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `около ${minutes} мин`;
  return `около ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function drawRoutes() {
  routeLayer.eachLayer((layer) => {
    if (!layer.options || !layer.options.pointMarker) routeLayer.removeLayer(layer);
  });
  drawRoutePoints();
  if (!routeData) return;
  const selectedIds = new Set([routeData.cool_route_id, routeData.normal_route_id]);
  for (const route of routeData.routes) {
    if (!selectedIds.has(route.id)) continue;
    const isActive = route.id === (activeRoute === 'cool' ? routeData.cool_route_id : routeData.normal_route_id);
    const isCool = route.id === routeData.cool_route_id;
    const line = L.geoJSON({ type: 'LineString', coordinates: route.geometry }, {
      style: { color: isCool ? '#2c875a' : '#82928a', weight: isActive ? 6 : 4, opacity: isActive ? 0.9 : 0.48, dashArray: isActive ? null : '7 8' },
    });
    routeLayer.addLayer(line);
  }
  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.13), { maxZoom: 16 });
}

function updateRouteCards() {
  const cool = routeData.routes.find((route) => route.id === routeData.cool_route_id);
  const normal = routeData.routes.find((route) => route.id === routeData.normal_route_id);
  const environmentSummary = cool.green_points === null
    ? 'Экоданные временно недоступны'
    : `${cool.green_points} зелёных зон · ${cool.water_points} мест с водой`;
  const greenSeparator = environmentSummary ? ` · ${environmentSummary}` : '';
  $('coolMeta').textContent = `${formatDistance(cool.distance)} · ${formatTime(cool.duration)}${greenSeparator}`;
  $('coolScore').textContent = `${cool.comfort}/100`;
  $('normalMeta').textContent = cool.id === normal.id
    ? `${formatDistance(normal.distance)} · совпадает с прохладным`
    : `${formatDistance(normal.distance)} · ${formatTime(normal.duration)}`;
  $('normalScore').textContent = `${normal.comfort}/100`;
  $('coolOption').classList.toggle('active', activeRoute === 'cool');
  $('normalOption').classList.toggle('active', activeRoute === 'normal');
  $('routeResults').hidden = false;
  if (cool.green_points === null) showToast('Экоданные недоступны: индекс рассчитан по длине пути и погоде');
  else if (routeData.temperature === null && routeData.weather_warning) {
    showToast('Погодные данные недоступны: маршрут построен без учёта температуры');
  }
}

function activateRoute(which) {
  if (!routeData) return;
  activeRoute = which;
  updateRouteCards();
  drawRoutes();
}

async function findRoutes(event) {
  event.preventDefault();
  const requestRevision = ++routeRequestRevision;
  setMapMode(null);
  routeError.textContent = '';
  routeButton.disabled = true;
  $('footMode').disabled = true;
  $('bikeMode').disabled = true;
  routeButton.querySelector('span').textContent = 'Ищем путь…';
  try {
    startPoint = await resolveLocation(startInput, startPoint);
    if (requestRevision !== routeRequestRevision) return;
    endPoint = await resolveLocation(endInput, endPoint);
    if (requestRevision !== routeRequestRevision) return;
    const start = `${startPoint.longitude},${startPoint.latitude}`;
    const end = `${endPoint.longitude},${endPoint.latitude}`;
    const result = await api(
      `/api/routes?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&mode=${transportMode}`,
    );
    if (requestRevision !== routeRequestRevision) return;
    routeData = result;
    activeRoute = 'cool';
    drawRoutePoints();
    updateRouteCards();
    drawRoutes();
  } catch (error) {
    if (requestRevision !== routeRequestRevision) return;
    routeError.textContent = error.message;
    clearRouteDisplay();
    drawRoutePoints();
  } finally {
    if (requestRevision === routeRequestRevision) {
      routeButton.disabled = false;
      $('footMode').disabled = false;
      $('bikeMode').disabled = false;
      routeButton.querySelector('span').textContent = 'Найти прохладный путь';
    }
  }
}

function selectTransport(mode) {
  if (mode === transportMode) return;
  transportMode = mode;
  $('footMode').classList.toggle('active', mode === 'foot');
  $('footMode').setAttribute('aria-pressed', String(mode === 'foot'));
  $('bikeMode').classList.toggle('active', mode === 'bike');
  $('bikeMode').setAttribute('aria-pressed', String(mode === 'bike'));
  invalidateRouteData();
  drawRoutePoints();
  routeError.textContent = '';
  if (startInput.value.trim() && endInput.value.trim()) {
    $('routeForm').requestSubmit();
  } else {
    showToast(mode === 'bike' ? 'Выбран велосипедный маршрут' : 'Выбран пешеходный маршрут');
  }
}

function setMapMode(mode) {
  mapSelectionMode = mode;
  $('mapInstruction').hidden = !mode;
}

function beginReportMode() {
  setMapMode('report');
  showToast('Нажмите на карте, чтобы отметить жаркое место');
}

map.on('click', (event) => {
  if (!mapSelectionMode) return;
  if (mapSelectionMode === 'report') {
    reportTarget = { latitude: event.latlng.lat, longitude: event.latlng.lng };
    setMapMode(null);
    L.popup()
      .setLatLng(event.latlng)
      .setContent('<strong>Здесь жарко?</strong><br><button class="popup-report-button" id="confirmHeatReport">＋ Отправить отметку</button>')
      .openOn(map);
    window.setTimeout(() => {
      const button = $('confirmHeatReport');
      if (button) button.addEventListener('click', submitHeatReport);
    }, 0);
    return;
  }
  const selectedMode = mapSelectionMode;
  setPoint(selectedMode, event.latlng);
  setMapMode(null);
  showToast(selectedMode === 'start' ? 'Точка отправления выбрана' : 'Точка назначения выбрана');
});

function bindRouteOption(id, which) {
  const element = $(id);
  element.addEventListener('click', () => activateRoute(which));
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRoute(which);
    }
  });
}
bindRouteOption('coolOption', 'cool');
bindRouteOption('normalOption', 'normal');

$('routeForm').addEventListener('submit', findRoutes);
$('footMode').addEventListener('click', () => selectTransport('foot'));
$('bikeMode').addEventListener('click', () => selectTransport('bike'));
$('citySearchForm').addEventListener('submit', searchCities);
cityButton.addEventListener('click', () => {
  cityPicker.hidden = !cityPicker.hidden;
  cityButton.setAttribute('aria-expanded', String(!cityPicker.hidden));
  if (!cityPicker.hidden) citySearchInput.focus();
});
document.addEventListener('click', (event) => {
  if (!cityPicker.contains(event.target) && !cityButton.contains(event.target)) closeCityPicker();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !cityPicker.hidden) {
    closeCityPicker();
    cityButton.focus();
  }
});
startInput.addEventListener('focus', () => setMapMode('start'));
endInput.addEventListener('focus', () => setMapMode('end'));
startInput.addEventListener('input', () => {
  startPoint = null;
  startInput.dataset.resolvedName = '';
  invalidateRouteData();
  drawRoutePoints();
});
endInput.addEventListener('input', () => {
  endPoint = null;
  endInput.dataset.resolvedName = '';
  invalidateRouteData();
  drawRoutePoints();
});
$('clearRoutes').addEventListener('click', () => {
  invalidateRouteData();
  startPoint = null;
  endPoint = null;
  startInput.value = '';
  endInput.value = '';
  startInput.dataset.resolvedName = '';
  endInput.dataset.resolvedName = '';
  map.setView([selectedCity.latitude, selectedCity.longitude], selectedCity.zoom);
});
$('mapReportButton').addEventListener('click', beginReportMode);
$('reportButton').addEventListener('click', beginReportMode);
$('locateButton').addEventListener('click', () => {
  locationStatus.classList.remove('error');
  if (!navigator.geolocation) {
    locationStatus.textContent = 'Этот браузер не поддерживает определение местоположения.';
    locationStatus.classList.add('error');
    return;
  }
  if (!window.isSecureContext) {
    locationStatus.textContent = 'Геолокация работает только на localhost или защищённом HTTPS-сайте.';
    locationStatus.classList.add('error');
    return;
  }
  locateButton.disabled = true;
  locationStatus.textContent = 'Определяем ваше местоположение… Разрешите доступ, если браузер спросит.';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
      setPoint('start', latlng, 'Моё местоположение');
      selectedCity = {
        name: 'Рядом со мной',
        latitude: latlng.lat,
        longitude: latlng.lng,
        zoom: 15,
      };
      updateCityLabels();
      map.setView(latlng, 15);
      setMapMode('end');
      endInput.focus();
      const accuracy = Math.round(position.coords.accuracy);
      locationStatus.textContent = `Местоположение определено (точность около ${accuracy} м). Введите точку назначения.`;
      refreshCityData();
      locateButton.disabled = false;
    },
    (error) => {
      locationStatus.textContent = error.code === 1
        ? 'Доступ запрещён. Разрешите геолокацию для этого сайта в настройках браузера.'
        : error.code === 2
          ? 'Не удалось определить координаты. Проверьте GPS или подключение к сети.'
          : 'Определение местоположения заняло слишком много времени. Попробуйте ещё раз.';
      locationStatus.classList.add('error');
      locateButton.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
  );
});

document.querySelectorAll('.layer-chip').forEach((button) => {
  button.addEventListener('click', () => {
    const layerName = button.dataset.layer;
    const isActive = button.classList.toggle('active');
    const layer = { green: greenLayer, heat: heatLayer, water: waterLayer }[layerName];
    if (isActive) layer.addTo(map);
    else map.removeLayer(layer);
  });
});

async function submitHeatReport() {
  if (!reportTarget) return;
  try {
    const saved = await api('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reportTarget, category: 'hot', note: '' }),
    });
    L.marker([saved.latitude, saved.longitude], {
      icon: L.divIcon({ className: '', html: '<span class="custom-marker hot"></span>', iconSize: [19, 19], iconAnchor: [9, 9] }),
    }).bindPopup('Отметка жителя: здесь жарко').addTo(heatLayer);
    map.closePopup();
    $('reportStatus').textContent = 'Спасибо! Отметка добавлена на карту.';
    showToast('Спасибо, отметка о жаре отправлена');
    reportTarget = null;
    await loadInsights();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadWeather(revision = cityDataRevision) {
  try {
    const conditions = await api(
      `/api/weather?latitude=${selectedCity.latitude}&longitude=${selectedCity.longitude}`,
    );
    if (revision !== cityDataRevision) return;
    if (conditions.temperature === null) {
      $('feelsLike').textContent = 'Погода пока недоступна';
      return;
    }
    $('temperatureValue').textContent = `${Math.round(conditions.temperature)}°`;
    const feels = conditions.apparent_temperature;
    $('feelsLike').textContent = feels === null
      ? `${selectedCity.name}, сейчас`
      : `Ощущается как ${Math.round(feels)}°`;
    const width = Math.max(5, Math.min(100, ((conditions.temperature + 5) / 45) * 100));
    document.querySelector('.heat-meter > span').style.width = `${width}%`;
  } catch {
    if (revision === cityDataRevision) $('feelsLike').textContent = 'Погода пока недоступна';
  }
}

async function loadReports(revision = cityDataRevision) {
  try {
    const query = new URLSearchParams({
      latitude: String(selectedCity.latitude),
      longitude: String(selectedCity.longitude),
    });
    const reports = await api(`/api/reports?${query}`);
    if (revision !== cityDataRevision) return;
    reports.forEach((report) => {
      const isHot = report.category === 'hot';
      const className = isHot ? 'custom-marker hot' : report.category === 'no_water' ? 'custom-marker water' : 'custom-marker';
      const label = isHot ? 'Здесь жарко' : report.category === 'no_water' ? 'Нет питьевой воды' : 'Не хватает тени';
      L.marker([report.latitude, report.longitude], {
        icon: L.divIcon({ className: '', html: `<span class="${className}"></span>`, iconSize: [19, 19], iconAnchor: [9, 9] }),
      }).bindPopup(label).addTo(heatLayer);
    });
  } catch (error) {
    if (revision === cityDataRevision) showToast(error.message);
  }
}

async function loadInsights(revision = cityDataRevision) {
  try {
    const query = new URLSearchParams({
      latitude: String(selectedCity.latitude),
      longitude: String(selectedCity.longitude),
    });
    const insights = await api(`/api/city-insights?${query}`);
    if (revision !== cityDataRevision) return;
    $('reportCount').textContent = insights.total_reports;
    const list = $('hotspotList');
    if (!insights.hotspots.length) {
      list.innerHTML = '<span class="empty-hotspots">Пока нет отметок — добавьте первую.</span>';
      return;
    }
    list.replaceChildren(...insights.hotspots.slice(0, 3).map((spot) => {
      const row = document.createElement('span');
      row.className = 'hotspot-item';
      const place = document.createElement('span');
      place.textContent = `${Number(spot.latitude).toFixed(3)}, ${Number(spot.longitude).toFixed(3)}`;
      const count = document.createElement('strong');
      count.textContent = `${spot.reports} ${spot.reports === 1 ? 'отметка' : 'отметки'}`;
      row.append(place, count);
      return row;
    }));
  } catch (error) {
    if (revision === cityDataRevision) showToast(error.message);
  }
}

function setupMapLayers() {
  greenLayer.addTo(map);
  heatLayer.addTo(map);
}

async function loadPlaces(revision = cityDataRevision) {
  try {
    const places = await api(
      `/api/places?latitude=${selectedCity.latitude}&longitude=${selectedCity.longitude}`,
    );
    if (revision !== cityDataRevision) return;
    places.forEach((place) => {
      const isWater = place.type === 'water';
      const marker = L.marker([place.latitude, place.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<span class="custom-marker${isWater ? ' water' : ''}"></span>`,
          iconSize: [19, 19],
          iconAnchor: [9, 9],
        }),
      }).bindPopup(place.name);
      marker.addTo(isWater ? waterLayer : greenLayer);
    });
  } catch {
    if (revision === cityDataRevision) {
      showToast('Не удалось загрузить городские зелёные зоны из OpenStreetMap');
    }
  }
}

setupMapLayers();
updateCityLabels();
refreshCityData();
