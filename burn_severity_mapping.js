/* ----------------------------------------------------------------------------------

Author: Fabian Löw
Date: April 2023
Purpose: Calculate normalized burn ratio (NBR), based on satellite images, to
         assess the burn severity in an area affected by wildfire
Input:
  - prefire_start (string): Begin of the pre-fire observation period
  - prefire_end (string): End of the pre-fire observation period
  - postfire_start (string): Begin of the post-fire observation period
  - postfire_end (string): End of the post-fire observation period
  - platform (string): Indicates the satellite, S2 = Sentinel-2, L8 = Landsat-8
  - geometry (Object): Polygon defining the study area

Output:
  Batch task to export the analysis results (Burn severity classes)

Notes:
  To delineate your study area, utilize the polygon tool located at the top 
  left corner of the map pane. Each single click will add a vertex, while a 
  double-click will finalize the shape of the polygon. Please ensure to be 
  cautious and follow these steps:
  1. Locate the polygon tool in the top left corner of the map pane.
  2. Use single clicks to add vertices and create the desired shape for your study area.
  3. When you have completed the polygon, double-click to confirm the shape.
  4. Pay attention to the 'Geometry Imports' option, situated at the top left of the map pane.
  
  To establish a period preceding the occurrence of the fire, you need to define the start 
  and end dates. It is essential to ensure that the duration is sufficiently long for 
  Sentinel-2 to capture an image, considering its repetition rate of 5 days. In case your 
  ImageCollections (visible in the Console) do not contain any elements, you may need to 
  modify these parameters. The event at Lake Ohau in New Zealand started at 04-Oct 2020, 
  the duration was circa 9 days

-----------------------------------------------------------------------------------*/


// STEP 1: Define user input parameters

// Define the pre-fire period
var prefire_start = '2019-10-10';   
var prefire_end = '2019-11-30';

// Define the post-fire period
var postfire_start = '2020-10-10';
var postfire_end = '2020-11-30';

// Select Sentinel-2 (S2) or Landsat-8 (L8)
var platform = 'S2';

// Print selected satellite platform and dates to GEE console
if (platform == 'S2' | platform == 's2') {
  var ImCol = 'COPERNICUS/S2';
  var pl = 'Sentinel-2';
} else {
  var ImCol = 'LANDSAT/LC08/C01/T1_SR';
  var pl = 'Landsat 8';
}

print(ee.String('Data selected for analysis: ').cat(pl));
print(ee.String('Fire incident occurred between ').cat(prefire_end).cat(' and ').cat(postfire_start));

// Define the location
var area = ee.FeatureCollection(geometry);

// Set study area as map center
Map.centerObject(area);


// STEP 2 (from here without further user input): Create and filter ImageCollections

var imagery = ee.ImageCollection(ImCol);

// Pre-fire image collection
var prefireImCol = ee.ImageCollection(imagery
    // Filter by dates.
    .filterDate(prefire_start, prefire_end)
    // Filter by location.
    .filterBounds(area));
    
// Post-fire image collection
var postfireImCol = ee.ImageCollection(imagery
    // Filter by dates.
    .filterDate(postfire_start, postfire_end)
    // Filter by location.
    .filterBounds(area));

// Add the clipped images to the console on the right
print("Pre-fire ImageCollection: ", prefireImCol); 
print("Post-fire ImageCollection: ", postfireImCol);


// STEP 3: Mask clouds and snow

// Function to mask clouds from the pixel quality band of Sentinel-2 SR data.
function maskS2sr(image) {
  // Bits 10 and 11 are clouds and cirrus, respectively.
  var cloudBitMask = ee.Number(2).pow(10).int();
  var cirrusBitMask = ee.Number(2).pow(11).int();
  // Get the pixel QA band.
  var qa = image.select('QA60');
  // All flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
      .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  // Return the masked image, scaled to TOA reflectance, without the QA bands.
  return image.updateMask(mask)
      .copyProperties(image, ["system:time_start"]);
}

// Function to mask clouds from the pixel quality band of Landsat 8 SR data.
function maskL8sr(image) {
  // Bits 3 and 5 are cloud shadow and cloud, respectively.
  var cloudShadowBitMask = 1 << 3;
  var cloudsBitMask = 1 << 5;
  var snowBitMask = 1 << 4;
  // Get the pixel QA band.
  var qa = image.select('pixel_qa');
  // All flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudShadowBitMask).eq(0)
      .and(qa.bitwiseAnd(cloudsBitMask).eq(0))
      .and(qa.bitwiseAnd(snowBitMask).eq(0));
  // Return the masked image, scaled to TOA reflectance, without the QA bands.
  return image.updateMask(mask)
      .select("B[0-9]*")
      .copyProperties(image, ["system:time_start"]);
}

// Use advanced cloud filtering for Sentinel-2, instead of maskS2sr
var Sentinel2_CloudScore  = require('users/S2_NDVI/NZ:functions/Sentinel2_CloudScore_Function');

// Apply platform-specific cloud mask
if (platform == 'S2' | platform == 's2') {
  var prefire_CM_ImCol = Sentinel2_CloudScore.Sentinel2_CloudScore_Function(prefireImCol); //prefireImCol.map(maskS2sr);
  var postfire_CM_ImCol = Sentinel2_CloudScore.Sentinel2_CloudScore_Function(postfireImCol); //postfireImCol.map(maskS2sr);
} else {
  var prefire_CM_ImCol = prefireImCol.map(maskL8sr);
  var postfire_CM_ImCol = postfireImCol.map(maskL8sr);
}

    
// STEP 4: Mosaic and clip images to study area, and apply a mask water

// JRC layer on surface water seasonality (where there is water > 10 months of the year)
var swater = ee.Image('JRC/GSW1_0/GlobalSurfaceWater').select('seasonality').clip(area);
var swater_mask = ee.Image.constant(1).where(swater.gte(10).updateMask(swater.gte(10)), 0);

var pre_mos = prefireImCol.mosaic().mask(swater_mask).clip(area);
var post_mos = postfireImCol.mosaic().mask(swater_mask).clip(area);

var pre_cm_mos = prefire_CM_ImCol.mosaic().mask(swater_mask).clip(area);
var post_cm_mos = postfire_CM_ImCol.mosaic().mask(swater_mask).clip(area);



// STEP 5: Calculate NBR for pre- and post-fire epochs

// Apply platform-specific NBR formula = (NIR-SWIR2) / (NIR+SWIR2)
if (platform == 'S2' | platform == 's2') {
  var preNBR = pre_cm_mos.normalizedDifference(['B8', 'B12']);
  var postNBR = post_cm_mos.normalizedDifference(['B8', 'B12']);
} else {
  var preNBR = pre_cm_mos.normalizedDifference(['B5', 'B7']);
  var postNBR = post_cm_mos.normalizedDifference(['B5', 'B7']);
}


// STEP 6: Calculate difference between pre- and post-fire images

// The result is called delta NBR or dNBR
var dNBR_unscaled = preNBR.subtract(postNBR);

// Scale product to USGS standards
var dNBR = dNBR_unscaled.multiply(1000);


// STEP 6: Show relevant layers in the map view

// Add the study area boundary.
Map.addLayer(area.draw({color: 'ffffff', strokeWidth: 5}), {},'User selected study area');

// Apply platform-specific visualization parameters for true color images
if (platform == 'S2' | platform == 's2') {
  var vis_params = {bands: ['B4', 'B3', 'B2'], max: 2000, gamma: 1.5};
} else {
  var vis_params = {bands: ['B4', 'B3', 'B2'], min: 0, max: 4000, gamma: 1.5};
}

// Add the true color images to the map
Map.addLayer(pre_mos, vis_params,'Pre-fire image');
Map.addLayer(post_mos, vis_params,'Post-fire image');

// Add the true color images to the map
Map.addLayer(pre_cm_mos, vis_params,'Pre-fire true color image - Clouds masked');
Map.addLayer(post_cm_mos, vis_params,'Post-fire true color image - Clouds masked');

// Define an SLD style of discrete intervals to apply to the image
var sld_intervals =
  '<RasterSymbolizer>' +
    '<ColorMap type="intervals" extended="false" >' +
      '<ColorMapEntry color="#ffffff" quantity="-500" label="-500"/>' +
      '<ColorMapEntry color="#7a8737" quantity="-250" label="-250" />' +
      '<ColorMapEntry color="#acbe4d" quantity="-100" label="-100" />' +
      '<ColorMapEntry color="#0ae042" quantity="100" label="100" />' +
      '<ColorMapEntry color="#fff70b" quantity="270" label="270" />' +
      '<ColorMapEntry color="#ffaf38" quantity="440" label="440" />' +
      '<ColorMapEntry color="#ff641b" quantity="660" label="660" />' +
      '<ColorMapEntry color="#a41fd6" quantity="2000" label="2000" />' +
    '</ColorMap>' +
  '</RasterSymbolizer>';

// Add the image to the map using both the color ramp and interval schemes.
Map.addLayer(dNBR.sldStyle(sld_intervals), {}, 'dNBR classified');

// Seperate result into 8 burn severity classes
var thresholds = ee.Image([-1000, -251, -101, 99, 269, 439, 659, 2000]);
var classified = dNBR.lt(thresholds).reduce('sum').toInt();

// set position of panel
var legend = ui.Panel({
  style: {
    position: 'bottom-left',
    padding: '8px 15px'
  }});
 
// Create legend title
var legendTitle = ui.Label({
  value: 'dNBR Classes',
  style: {fontWeight: 'bold',
    fontSize: '18px',
    margin: '0 0 4px 0',
    padding: '0'
    }});
 
// Add the title to the panel
legend.add(legendTitle);
 
// Creates and styles 1 row of the legend.
var makeRow = function(color, name) {
 
      // Create the label that is actually the colored box.
      var colorBox = ui.Label({
        style: {
          backgroundColor: '#' + color,
          // Use padding to give the box height and width.
          padding: '8px',
          margin: '0 0 4px 0'
        }});
 
      // Create the label filled with the description text.
      var description = ui.Label({
        value: name,
        style: {margin: '0 0 4px 6px'}
      });
 
      // return the panel
      return ui.Panel({
        widgets: [colorBox, description],
        layout: ui.Panel.Layout.Flow('horizontal')
      })};
 
//  Palette with the colors
var palette =['7a8737', 'acbe4d', '0ae042', 'fff70b', 'ffaf38', 'ff641b', 'a41fd6', 'ffffff'];
 
// name of the legend
var names = ['Enhanced Regrowth, High','Enhanced Regrowth, Low','Unburned', 'Low Severity',
'Moderate-low Severity', 'Moderate-high Severity', 'High Severity', 'NA'];
 
// Add color and and names
for (var i = 0; i < 8; i++) {
  legend.add(makeRow(palette[i], names[i]));
  }  
 
// add legend to map (alternatively you can also print the legend to the console)
Map.add(legend);

var id = dNBR.id().getInfo();
      
Export.image.toDrive({image: dNBR, scale: 10, description: id, fileNamePrefix: 'dNBR',
  region: area, maxPixels: 1e10});
