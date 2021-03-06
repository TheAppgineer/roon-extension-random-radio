// Copyright 2017, 2018 The Appgineer
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
const PROFILE = 'Profile';

const NATIVE_MATH = 0;
const BROWSER_CRYPTO = 1;
const MT19937 = 2;

var Random           = require('random-js'),
    RoonApi          = require('node-roon-api'),
    RoonApiSettings  = require('node-roon-api-settings'),
    RoonApiStatus    = require('node-roon-api-status'),
    RoonApiTransport = require('node-roon-api-transport'),
    RoonApiBrowse    = require('node-roon-api-browse');

var initialized = false;
var random = undefined;
var core = undefined;
var transport = undefined;
var waiting_zones = {};
var profiles = [];

var roon = new RoonApi({
    extension_id:        'com.theappgineer.random-radio',
    display_name:        'Random Radio',
    display_version:     '0.2.1',
    publisher:           'The Appgineer',
    email:               'theappgineer@gmail.com',
    website:             'https://community.roonlabs.com/t/roon-extension-random-radio/35978',

    core_paired: function(core_) {
        core = core_;
        transport = core.services.RoonApiTransport;

        transport.subscribe_zones((response, msg) => {
            let zones = [];

            if (response == "Subscribed") {
                zones = msg.zones;

                init(radio_settings);
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
    profile: '',
    engine:  MT19937
};

function refresh_browse(opts, path, cb) {
    opts = Object.assign({ hierarchy: "browse" }, opts);

    core.services.RoonApiBrowse.browse(opts, (err, r) => {
        if (err == false) {
            if (r.action == "list") {
                let list_offset = 0;

                if (path && path[0] == 'Library' && r.list.level == 2 && r.list.title == path[r.list.level - 1]) {
                    list_offset = random.integer(0, r.list.count - 1);
                } else {
                    list_offset = r.list.display_offset > 0 ? r.list.display_offset : 0;
                }
                load_browse(list_offset, path, cb);
            }
        }
    });
}

function load_browse(list_offset, path, cb) {
    let opts = {
        hierarchy:          "browse",
        offset:             list_offset,
        set_display_offset: list_offset
    };

    core.services.RoonApiBrowse.load(opts, (err, r) => {
        if (err == false && path) {
            if (!r.list.level || !path[r.list.level - 1] || r.list.title == path[r.list.level - 1]) {
                for (let i = 0; i < r.items.length; i++) {
                    let match = (r.items[i].title == path[r.list.level]);

                    if (!path[r.list.level] || match) {
                        if (r.list.level < path.length - 1) {
                            refresh_browse({ item_key: r.items[i].item_key }, path, cb);
                            break;
                        } else if (cb) {
                            cb(r.items[i], match || i + 1 == r.items.length);
                        }
                    }
                }
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
    let group = {
        type:    "group",
        title:   "Select the random mode for the available zones:",
        items:   [],
    };

    l.layout.push({
        type:    "dropdown",
        title:   "Profile",
        values:  profiles,
        setting: "profile"
    });

    l.layout.push({
        type:    "dropdown",
        title:   "Random Number Generator",
        values:  [
            { title: "Native Math",         value: NATIVE_MATH    },
            { title: "Browser Crypto",      value: BROWSER_CRYPTO },
            { title: "MT19937 (auto seed)", value: MT19937        }
        ],
        setting: "engine"
    });

    group.items.push({
        type:    "zone",
        title:   "Zone",
        setting: "zone"
    });

    if (settings.zone && settings.zone.output_id) {
        let i = settings.zone.output_id;

        group.items.push({
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

    l.layout.push(group);

    return l;
}

function on_stopped(zone, user_request) {
    if (!zone.is_play_allowed || user_request) {
        let path;

        if (radio_settings[zone.outputs[0].output_id] == TRACK) {
            path = ['Library', TRACK, '', 'Play Now'];
        } else if (radio_settings[zone.outputs[0].output_id] == ALBUM) {
            path = ['Library', ALBUM, '', 'Play Album', 'Play Now'];
        }

        refresh_browse({ pop_all: true }, path, (item) => {
            const source_opts = {
                hierarchy:         "browse",
                zone_or_output_id: zone.zone_id,
                item_key:          item.item_key
            };

            refresh_browse(source_opts);
            setup_stop_monitoring(zone);
        });
    } else {
        setup_play_monitoring(zone);
    }
}

function turn_roon_radio_off(zone, cb) {
    setTimeout(() => {
        transport.change_settings(zone, { auto_radio: false });

        cb && cb();
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
            turn_roon_radio_off(zone, () => {
                // Only allow reactivation after playback stopped
                on_zone_property_changed(zone.zone_id, { state: 'stopped' }, (zone) => {
                    setup_play_monitoring(zone);
                });
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
            turn_roon_radio_off(zone, () => {
                // And start our own
                on_stopped(zone, true);
            });
        }
    });
}

function setup_callbacks(settings) {
    let status_string = '';

    for(var key in settings) {
        if (key === 'zone' || key === 'engine' || key === 'profile') {
            continue;
        }
        let zone = transport.zone_by_output_id(key);

        if (zone) {
            if (settings[key]) {
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
            } else {
                delete waiting_zones[zone.zone_id];
            }
        }
    }

    // Update status
    svc_status.set_status(status_string ? status_string : 'No active zones', false);
}

function start_engine(settings) {
    if (!initialized || settings.engine != radio_settings.engine) {
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

function query_profiles(cb) {
    profiles = [];      // Start off with an empty list

    refresh_browse({ pop_all: true }, [ 'Settings', PROFILE, '' ], (item, done) => {
        profiles.push({
            title: item.title,
            value: item.title
        });

        if (done && cb) {
            cb();
        }
    });
}

function select_profile(settings) {
    if (settings.profile && (!initialized || settings.profile != radio_settings.profile)) {
        refresh_browse({ pop_all: true }, [ 'Settings', PROFILE, settings.profile ], (item) => {
            const source_opts = {
                hierarchy: "browse",
                item_key:  item.item_key
            };

            refresh_browse(source_opts);

            console.log("Selected profile:", settings.profile);
        });
    }
}

function init(settings) {
    select_profile(settings);
    start_engine(settings);
    setup_callbacks(settings);

    initialized = true;
}

function init_signal_handlers() {
    const handle = function(signal) {
        process.exit(0);
    };

    // Register signal handlers to enable a graceful stop of the container
    process.on('SIGTERM', handle);
    process.on('SIGINT', handle);
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        query_profiles(() => {
            cb(makelayout(radio_settings));
        });
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            init(l.values);
            radio_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", radio_settings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);

roon.init_services({
    required_services:   [ RoonApiTransport, RoonApiBrowse ],
    provided_services:   [ svc_settings, svc_status ]
});

init_signal_handlers();

roon.start_discovery();
