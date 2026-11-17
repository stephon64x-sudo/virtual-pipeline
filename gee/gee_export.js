// Desert Water Early Warning: data export for northern Kenya, 2019-2023
// Paste into https://code.earthengine.google.com, click Run,
// then open the "Tasks" tab (top right) and click RUN on each of the 4 exports.
// The CSVs land in your Google Drive, in a folder called "desert_water".

var sites = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Point([40.06, 1.75]).buffer(3000), {site: 'Wajir'}),
  ee.Feature(ee.Geometry.Point([41.86, 3.94]).buffer(3000), {site: 'Mandera'}),
  ee.Feature(ee.Geometry.Point([37.07, 3.32]).buffer(3000), {site: 'NorthHorr'})
]);
var START = '2019-01-01';
var END = '2024-01-01';

Map.centerObject(sites, 6);
Map.addLayer(sites, {color: 'red'}, 'sites');

// Average every image over each site, keep site + date + values
function toTable(col, scale) {
  return col.map(function (img) {
    var date = img.date().format('YYYY-MM-dd');
    return img.reduceRegions({collection: sites, reducer: ee.Reducer.mean(), scale: scale})
      .map(function (f) { return f.set('date', date); });
  }).flatten();
}

function exportCsv(fc, name, columns) {
  Export.table.toDrive({
    collection: fc,
    description: name,
    folder: 'desert_water',
    fileFormat: 'CSV',
    selectors: columns
  });
}

// 1. Rainfall: CHIRPS daily (mm/day)
var chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
  .filterDate(START, END).select('precipitation');
exportCsv(toTable(chirps, 5000), 'chirps_rain', ['site', 'date', 'mean']);

// 2. Vegetation: MODIS NDVI, 16-day composites (cloud-robust; divide by 10000 later)
var modis = ee.ImageCollection('MODIS/061/MOD13Q1')
  .filterDate(START, END).select('NDVI');
exportCsv(toTable(modis, 250), 'modis_ndvi', ['site', 'date', 'mean']);

// 3. Groundwater / total water storage: GRACE mascons, monthly (cm anomaly)
var grace = ee.ImageCollection('NASA/GRACE/MASS_GRIDS_V04/MASCON_CRI')
  .filterDate(START, END).select('lwe_thickness');
exportCsv(toTable(grace, 50000), 'grace_lwe', ['site', 'date', 'mean']);

// 4. Sentinel-2 NDVI + cloud fraction per scene (shows how we handle cloudy images)
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(sites).filterDate(START, END)
  .map(function (img) {
    var scl = img.select('SCL');
    var cloud = scl.eq(3).or(scl.eq(8)).or(scl.eq(9)).or(scl.eq(10)).rename('cloud');
    var ndvi = img.normalizedDifference(['B8', 'B4']).rename('ndvi');
    return ndvi.addBands(cloud).copyProperties(img, ['system:time_start']);
  });
exportCsv(toTable(s2, 20), 's2_ndvi_cloud', ['site', 'date', 'ndvi', 'cloud']);
