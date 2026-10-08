const { Module } = require('../core/handler');
const axios = require('axios');

Module({
    pattern: 'weather ?(.*)',
    fromMe: false,
    desc: 'Get weather information for any city',
    type: 'utility'
}, async (message, match) => {
    try {
        const city = match[1];
        
        if (!city) {
            return await message.sendReply('❌ Please provide a city name!\n\nExample: .weather Delhi');
        }

        await message.sendReply('🔍 Fetching weather information...');

        const geocodeResponse = await axios.get(`https://geocoding-api.open-meteo.com/v1/search`, {
            params: {
                name: city,
                count: 1,
                language: 'en',
                format: 'json'
            }
        });

        if (!geocodeResponse.data.results || geocodeResponse.data.results.length === 0) {
            return await message.sendReply('❌ City not found! Please check the spelling and try again.');
        }

        const location = geocodeResponse.data.results[0];
        const { latitude, longitude, name, country } = location;

        const weatherResponse = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
            params: {
                latitude: latitude,
                longitude: longitude,
                current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
                daily: 'sunrise,sunset',
                timezone: 'auto',
                forecast_days: 1
            }
        });

        const current = weatherResponse.data.current;
        const daily = weatherResponse.data.daily;

        const getWeatherEmoji = (weatherCode, isDay) => {
            const weatherCodes = {
                0: isDay ? '☀️' : '🌙',
                1: isDay ? '🌤️' : '🌙',
                2: '⛅',
                3: '☁️',
                45: '🌫️',
                48: '🌫️',
                51: '🌦️',
                53: '🌦️',
                55: '🌧️',
                61: '🌦️',
                63: '🌧️',
                65: '🌧️',
                80: '🌦️',
                81: '🌧️',
                82: '🌧️',
                95: '⛈️',
                96: '⛈️',
                99: '⛈️'
            };
            return weatherCodes[weatherCode] || '🌤️';
        };

        const getWeatherDescription = (weatherCode) => {
            const descriptions = {
                0: 'Clear sky',
                1: 'Mainly clear',
                2: 'Partly cloudy',
                3: 'Overcast',
                45: 'Fog',
                48: 'Depositing rime fog',
                51: 'Light drizzle',
                53: 'Moderate drizzle',
                55: 'Dense drizzle',
                61: 'Slight rain',
                63: 'Moderate rain',
                65: 'Heavy rain',
                80: 'Slight rain showers',
                81: 'Moderate rain showers',
                82: 'Violent rain showers',
                95: 'Thunderstorm',
                96: 'Thunderstorm with hail',
                99: 'Thunderstorm with heavy hail'
            };
            return descriptions[weatherCode] || 'Unknown';
        };

        const getWindDirection = (deg) => {
            const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
            return directions[Math.round(deg / 22.5) % 16];
        };

        const temperature = Math.round(current.temperature_2m);
        const feelsLike = Math.round(current.apparent_temperature);
        const humidity = current.relative_humidity_2m;
        const pressure = Math.round(current.pressure_msl);
        const windSpeed = Math.round(current.wind_speed_10m);
        const windDirection = getWindDirection(current.wind_direction_10m);
        const cloudCover = current.cloud_cover;
        const weatherCode = current.weather_code;
        const isDay = current.is_day;
        const description = getWeatherDescription(weatherCode);
        const emoji = getWeatherEmoji(weatherCode, isDay);

        const sunrise = new Date(daily.sunrise[0]).toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
        });
        const sunset = new Date(daily.sunset[0]).toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
        });

        const weatherInfo = `${emoji} *Weather in ${name}, ${country}*

🌡️ *Temperature:* ${temperature}°C (feels like ${feelsLike}°C)
☁️ *Condition:* ${description}
💧 *Humidity:* ${humidity}%
🔽 *Pressure:* ${pressure} hPa
💨 *Wind:* ${windSpeed} km/h ${windDirection}
☁️ *Cloud Cover:* ${cloudCover}%
🌅 *Sunrise:* ${sunrise}
🌇 *Sunset:* ${sunset}

_Powered by v3shn@Raganork-MD_`;

        await message.sendReply(weatherInfo);

    } catch (error) {
        console.error('Weather API Error:', error);
        
        if (error.code === 'ENOTFOUND') {
            await message.sendReply('❌ No internet connection! Please check your network.');
        } else {
            await message.sendReply('❌ Something went wrong while fetching weather data!');
        }
    }
});

Module({
    pattern: 'forecast ?(.*)',
    fromMe: false,
    desc: 'Get 7-day weather forecast',
    type: 'utility'
}, async (message, match) => {
    try {
        const city = match[1];
        
        if (!city) {
            return await message.sendReply('❌ Please provide a city name!\n\nExample: .forecast Delhi');
        }

        await message.sendReply('🔍 Fetching weather forecast...');

        const geocodeResponse = await axios.get(`https://geocoding-api.open-meteo.com/v1/search`, {
            params: {
                name: city,
                count: 1,
                language: 'en',
                format: 'json'
            }
        });

        if (!geocodeResponse.data.results || geocodeResponse.data.results.length === 0) {
            return await message.sendReply('❌ City not found! Please check the spelling and try again.');
        }

        const location = geocodeResponse.data.results[0];
        const { latitude, longitude, name, country } = location;

        const forecastResponse = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
            params: {
                latitude: latitude,
                longitude: longitude,
                daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
                timezone: 'auto',
                forecast_days: 7
            }
        });

        const daily = forecastResponse.data.daily;

        const getWeatherEmoji = (weatherCode) => {
            const weatherCodes = {
                0: '☀️',
                1: '🌤️',
                2: '⛅',
                3: '☁️',
                45: '🌫️',
                48: '🌫️',
                51: '🌦️',
                53: '🌦️',
                55: '🌧️',
                61: '🌦️',
                63: '🌧️',
                65: '🌧️',
                80: '🌦️',
                81: '🌧️',
                82: '🌧️',
                95: '⛈️',
                96: '⛈️',
                99: '⛈️'
            };
            return weatherCodes[weatherCode] || '🌤️';
        };

        const getWeatherDescription = (weatherCode) => {
            const descriptions = {
                0: 'Clear',
                1: 'Mainly clear',
                2: 'Partly cloudy',
                3: 'Overcast',
                45: 'Fog',
                48: 'Rime fog',
                51: 'Light drizzle',
                53: 'Drizzle',
                55: 'Heavy drizzle',
                61: 'Light rain',
                63: 'Rain',
                65: 'Heavy rain',
                80: 'Rain showers',
                81: 'Heavy showers',
                82: 'Violent showers',
                95: 'Thunderstorm',
                96: 'Thunderstorm + hail',
                99: 'Heavy thunderstorm'
            };
            return descriptions[weatherCode] || 'Unknown';
        };

        let forecastText = `📅 *7-Day Weather Forecast for ${name}, ${country}*\n\n`;

        for (let i = 0; i < 7; i++) {
            const date = new Date(daily.time[i]);
            const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const maxTemp = Math.round(daily.temperature_2m_max[i]);
            const minTemp = Math.round(daily.temperature_2m_min[i]);
            const weatherCode = daily.weather_code[i];
            const description = getWeatherDescription(weatherCode);
            const emoji = getWeatherEmoji(weatherCode);
            const precipitation = daily.precipitation_sum[i];
            const windSpeed = Math.round(daily.wind_speed_10m_max[i]);
            
            forecastText += `${emoji} *${dayName}, ${dateStr}*\n`;
            forecastText += `   ${maxTemp}°C / ${minTemp}°C • ${description}`;
            if (precipitation > 0) {
                forecastText += ` • ${precipitation}mm rain`;
            }
            forecastText += `\n   💨 Wind: ${windSpeed} km/h\n\n`;
        }

        forecastText += '_Powered by v3shn@Raganork-MD_';

        await message.sendReply(forecastText);

    } catch (error) {
        console.error('Forecast API Error:', error);
        await message.sendReply('❌ Something went wrong while fetching forecast data!');
    }
});