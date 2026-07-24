console.log("summarizing station", toolInput.station_id);
const readings = toolInput.readings || [];
const avgTemp = readings.reduce((s, r) => s + r.tempC, 0) / (readings.length || 1);
return { stationId: toolInput.station_id, sampleCount: readings.length, avgTempC: avgTemp };
