// Copyright 2017 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

const TRACK = 'Tracks';
const ALBUM = 'Albums';

const NATIVE_MATH = 0;
const BROWSER_CRYPTO = 1;
const MT19937 = 2;

var Random           = require('random-js'),
    RoonApi          = require('node-roon-api'),
    RoonApiSettings  = require('node-roon-api-settings'),
    RoonApiStatus    = require('node-roon-api-status'),
    RoonApiTransport = require('node-roon-api-transport'),
    RoonApiBrowse    = require('node-roon-api-browse');

var random = undefined;
var core = undefined;
var transport = undefined;
var waiting_zones = {};

var roon = new RoonApi({
    extension_id:        'com.theappgineer.random-radio',
    display_name:        'Random Radio',
    display_version:     '0.1.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://github.com/TheAppgineer/roon-extension-random-radio',

    core_paired: function(core_) {
        core = core_;
        transport = core.services.RoonApiTransport;

        transport.subscribe_zones((response, msg) => {
            let zones = [];

            if (response == "Subscribed") {
                zones = msg.zones;

                start_engine(radio_settings);
                setup_callbacks(radio_settings);
            } else if (response == "Changed") {
                if (msg.zones_changed) {
                    zones = msg.zones_changed;
                }
                if (msg.zones_added) {
                    zones = msg.zones_added;
                    setup_callbacks(radio_settings);
                }
            }

            if (zones) {
                zones.forEach(function(zone) {
                    const on_match = waiting_zones[zone.zone_id];

                    if (on_match && on_match.properties) {
                        let match = false;

                        if (on_match.properties.now_playing) {
                            const seek_position = on_match.properties.now_playing.seek_position;

                            // Sometimes a seek_position is missed by the API, allow 1 off
                            match = (seek_position != undefined && zone.now_playing &&
                                     (seek_position == zone.now_playing.seek_position ||
                                      seek_position + 1 == zone.now_playing.seek_position));

                            if (!match) {
                                const length = on_match.properties.now_playing.length;

                                match = (length != undefined && zone.now_playing &&
                                         zone.now_playing.length);
                            }
                        }
                        if (!match) {
                            const play_allowed = on_match.properties.is_play_allowed;
                            const pause_allowed = on_match.properties.is_pause_allowed;
                            const state = on_match.properties.state;

                            match = ((play_allowed != undefined && play_allowed == zone.is_play_allowed) ||
                                     (pause_allowed != undefined && pause_allowed == zone.is_pause_allowed) ||
                                     (state != undefined && state == zone.state));
                        }
                        if (!match) {
                            if (on_match.properties.settings) {
                                const auto_radio = on_match.properties.settings.auto_radio;

                                match = (auto_radio != undefined && zone.settings &&
                                         auto_radio == zone.settings.auto_radio);
                            }
                        }
                        if (match) {
                            delete waiting_zones[zone.zone_id];

                            if (on_match.cb) {
                                on_match.cb(zone);
                            }
                        }
                    }
                });
            }
        });
    },
    core_unpaired: function(core_) {
        core = undefined;
        transport = undefined;
    }
});

var radio_settings = roon.load_config("settings") || {
    engine: MT19937
};

function refresh_browse(opts, type, cb) {
    opts = Object.assign({ hierarchy: "browse" }, opts);

    core.services.RoonApiBrowse.browse(opts, (err, r) => {
        if (err == false) {
            if (r.action == "list") {
                let list_offset = 0;

                if (r.list.level == 2 && r.list.title == type) {
                    list_offset = random.integer(0, r.list.count - 1);
                } else {
                    list_offset = r.list.display_offset > 0 ? r.list.display_offset : 0;
                }
                load_browse(list_offset, type, cb);
            }
        }
    });
}

function load_browse(list_offset, type, cb) {
    let opts = {
        hierarchy:          "browse",
        offset:             list_offset,
        set_display_offset: list_offset
    };

    core.services.RoonApiBrowse.load(opts, (err, r) => {
        if (err == false) {
            switch(r.list.level) {
                case 0:
                    for (let i = 0; i < r.items.length; i++) {
                        if (r.items[i].title == 'Library') {
                            refresh_browse({ item_key: r.items[i].item_key }, type, cb);
                            break;
                        }
                    }
                    break;
                case 1:
                    if (r.list.title == 'Library') {
                        for (let i = 0; i < r.items.length; i++) {
                            if (r.items[i].title == type) {
                                refresh_browse({ item_key: r.items[i].item_key }, type, cb);
                                break;
                            }
                        }
                    }
                    break;
                case 2:
                    if (r.list.title == type) {
                        refresh_browse({ item_key: r.items[0].item_key }, type, cb);
                    }
                    break;
                case 3:
                    if (type == ALBUM && r.items[0].title == 'Play Album') {
                        refresh_browse({ item_key: r.items[0].item_key }, type, cb);
                        break;
                    }
                    // Fall through expected
                case 4:
                    for (let i = 0; i < r.items.length; i++) {
                        if (r.items[i].title == 'Play Now') {
                            cb && cb(r.items[i].item_key);
                            break;
                        }
                    }
                    break;
            }
        }
    });
}

function on_zone_property_changed(zone_id, properties, cb) {
    waiting_zones[zone_id] = { properties: properties, cb: cb };
}

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };

    l.layout.push({
        type:    "dropdown",
        title:   "Random Number Engine",
        values:  [
            { title: "Native Math",         value: NATIVE_MATH    },
            { title: "Browser Crypto",      value: BROWSER_CRYPTO },
            { title: "MT19937 (auto seed)", value: MT19937        }
        ],
        setting: "engine"
    });

    l.layout.push({
        type:    "zone",
        title:   "Zone",
        setting: "zone"
    });

    if (settings.zone && settings.zone.output_id) {
        let i = settings.zone.output_id;

        l.layout.push({
            type:    "dropdown",
            title:   "Random Mode",
            values:  [
                { title: "Off", value: ''    },
                { title: TRACK, value: TRACK },
                { title: ALBUM, value: ALBUM }
            ],
            setting: i
        });
    }

    return l;
}

function on_stopped(zone, user_request) {
    if (!zone.is_play_allowed || user_request) {
        refresh_browse({ pop_all: true }, radio_settings[zone.outputs[0].output_id], (item_key) => {
            const source_opts = {
                hierarchy:         "browse",
                zone_or_output_id: zone.zone_id,
                item_key:          item_key
            };

            refresh_browse(source_opts);
            setup_stop_monitoring(zone);
        });
    } else {
        setup_play_monitoring(zone);
    }
}

function turn_roon_radio_off(zone) {
    setTimeout(() => {
        transport.change_settings(zone, { auto_radio: false });
    }, 500);
}

function setup_stop_monitoring(zone) {
    const properties = {
        settings: { auto_radio: true },
        state:    'stopped'
    };

    console.log(zone.display_name, "setup stop monitoring");

    on_zone_property_changed(zone.zone_id, properties, (zone) => {
        if (zone.state == 'stopped') {
            on_stopped(zone);
        } else {
            turn_roon_radio_off(zone);

            // Only allow reactivation after playback stopped
            on_zone_property_changed(zone.zone_id, { state: 'stopped' }, (zone) => {
                setup_play_monitoring(zone);
            });
        }
    });
}

function setup_play_monitoring(zone) {
    const properties = {
        settings: { auto_radio: true },
        state:    'playing'
    };

    console.log(zone.display_name, "setup play monitoring");

    on_zone_property_changed(zone.zone_id, properties, (zone) => {
        if (zone.state == 'playing') {
            setup_callbacks(radio_settings);
        } else {
            turn_roon_radio_off(zone);

            // And start our own
            on_stopped(zone, true);
        }
    });
}

function setup_callbacks(settings) {
    let status_string = '';

    for(var key in settings) {
        if (key === 'zone' || key === 'engine') {
            continue;
        }
        if (settings[key]) {
            let zone = transport.zone_by_output_id(key);

            if (zone) {
                if (status_string) {
                    status_string += '\n';
                }
                status_string += zone.display_name + ': ' + settings[key];

                if (zone.state == 'playing') {
                    if (zone.now_playing.length) {
                        setup_stop_monitoring(zone);
                    } else {
                        const properties = {
                            now_playing: { length: true },
                            state:       'stopped'
                        };

                        console.log(zone.display_name, "setup now_playing.length monitoring");
                        on_zone_property_changed(zone.zone_id, properties, (zone) => {
                            setup_callbacks(radio_settings);
                        });
                    }
                } else {
                    setup_play_monitoring(zone);
                }
            }
        }
    }

    // Update status
    svc_status.set_status(status_string ? status_string : 'No active zones', false);
}

function start_engine(settings) {
    if (!random || settings.engine != radio_settings.engine) {
        let engine = '';

        switch(settings.engine) {
            case NATIVE_MATH:
                random = new Random(Random.engines.nativeMath);
                engine = 'nativeMath';
                break;
            case BROWSER_CRYPTO:
                random = new Random(Random.engines.browserCrypto);
                engine = 'browserCrypto';
                break;
            case MT19937:
                random = new Random(Random.engines.mt19937().autoSeed());
                engine = 'mt19937';
                break;
        }

        console.log('Random engine:', engine);
    }
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(radio_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            start_engine(l.values);
            radio_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", radio_settings);

            setup_callbacks(radio_settings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services:   [ RoonApiTransport, RoonApiBrowse ],
    provided_services:   [ svc_settings, svc_status ]
});

roon.start_discovery();
