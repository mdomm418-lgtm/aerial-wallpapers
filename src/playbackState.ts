// Copyright (C) 2026 Jeff Shee <jeffshee8969@gmail.com> and contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {RendererWrapper} from './dbus.js';
import {Logger} from './logger.js';

type StateName = 'playing' | 'pausedByUser' | 'pausedByAuto' | 'paused';
type EventName = 'userPlay' | 'userPause' | 'autoPlay' | 'autoPause';

interface StateTransition {
    target: StateName;
    action: () => void;
}

interface StateDefinition {
    actions: {onEnter: () => void; onExit: () => void};
    transitions: Partial<Record<EventName, StateTransition>>;
}

type StateMachineDefinition = {
    initialState: StateName;
} & Record<StateName, StateDefinition>;

interface StateMachine {
    value: StateName;
    transition(currentState: StateName, event: EventName): StateName | null;
}

function createMachine(def: StateMachineDefinition): StateMachine {
    const machine: StateMachine = {
        value: def.initialState,
        transition(currentState, event) {
            const currentStateDef = def[currentState];
            const destinationTransition = currentStateDef.transitions[event];
            if (!destinationTransition)
                return null;

            const destinationState = destinationTransition.target;
            const destinationStateDef = def[destinationState];

            destinationTransition.action();
            currentStateDef.actions.onExit();
            destinationStateDef.actions.onEnter();

            machine.value = destinationState;
            return machine.value;
        },
    };
    return machine;
}

export class PlaybackState {
    private logger = new Logger('playbackState');
    private renderer = new RendererWrapper();
    private machineDefinition: StateMachineDefinition;
    private machine!: StateMachine;
    private isPlayingChangedId: number | null = null;
    private destroyed = false;

    constructor() {
        this.machineDefinition = {
            initialState: 'playing',
            playing: {
                actions: {
                    onEnter: () => void this.renderer.setPlay(),
                    onExit() {},
                },
                transitions: {
                    userPause: {
                        target: 'pausedByUser',
                        action: () => this.logger.debug('playing -> pausedByUser'),
                    },
                    autoPause: {
                        target: 'pausedByAuto',
                        action: () => this.logger.debug('playing -> pausedByAuto'),
                    },
                },
            },
            pausedByUser: {
                actions: {
                    onEnter: () => void this.renderer.setPause(),
                    onExit() {},
                },
                transitions: {
                    userPlay: {
                        target: 'playing',
                        action: () => this.logger.debug('pausedByUser -> playing'),
                    },
                    autoPause: {
                        target: 'paused',
                        action: () => this.logger.debug('pausedByUser -> paused'),
                    },
                },
            },
            pausedByAuto: {
                actions: {
                    onEnter: () => void this.renderer.setPause(),
                    onExit() {},
                },
                transitions: {
                    autoPlay: {
                        target: 'playing',
                        action: () => this.logger.debug('pausedByAuto -> playing'),
                    },
                    userPause: {
                        target: 'paused',
                        action: () => this.logger.debug('pausedByAuto -> paused'),
                    },
                },
            },
            paused: {
                actions: {onEnter() {}, onExit() {}},
                transitions: {
                    userPlay: {
                        target: 'pausedByAuto',
                        action: () => this.logger.debug('paused -> pausedByAuto'),
                    },
                    autoPlay: {
                        target: 'pausedByUser',
                        action: () => this.logger.debug('paused -> pausedByUser'),
                    },
                },
            },
        };

        // Re-assert our intent if the renderer starts playing on its own, e.g.
        // a fresh process after a crash. The destroyed guard matters because a
        // leaked subscription here would fight the live instance forever.
        this.isPlayingChangedId = this.renderer.proxy.connectSignal(
            'isPlayingChanged',
            (_proxy: Gio.DBusProxy, _sender: string, [isPlaying]: [boolean]) => {
                if (this.destroyed)
                    return;
                if (isPlaying && this.getCurrentState() !== 'playing')
                    void this.renderer.setPause();
            }
        );
        this.reset();
    }

    /** Push the current state to the renderer, e.g. after it restarts. */
    syncRenderer(): void {
        if (this.destroyed)
            return;
        if (this.getCurrentState() === 'playing')
            void this.renderer.setPlay();
        else
            void this.renderer.setPause();
    }

    destroy(): void {
        this.destroyed = true;
        if (this.isPlayingChangedId !== null) {
            this.renderer.proxy.disconnectSignal(this.isPlayingChangedId);
            this.isPlayingChangedId = null;
        }
    }

    getCurrentState(): StateName {
        return this.machine.value;
    }

    reset(): void {
        this.machine = createMachine(this.machineDefinition);
    }

    userPlay(): void {
        this.apply('userPlay');
    }

    autoPlay(): void {
        this.apply('autoPlay');
    }

    userPause(): void {
        this.apply('userPause');
    }

    autoPause(): void {
        this.apply('autoPause');
    }

    /**
     * Commands to the renderer are fire-and-forget, so this state is only our
     * intent and the renderer can drift out of sync with it — a call that lost
     * a race with renderer startup, a crash, or a restarted process. When an
     * event doesn't change state, re-assert it so the drift heals instead of
     * leaving playback stuck until something happens to force a transition.
     *
     * @param {EventName} event - the event to feed the state machine
     */
    private apply(event: EventName): void {
        if (!this.machine.transition(this.getCurrentState(), event))
            this.syncRenderer();
    }
}
