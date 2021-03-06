'use strict';
import { MessageItem, window } from 'vscode';
import { LogLevel } from '../configuration';
import { extensionId } from '../constants';
import { LogCallerContext, Logger } from '../logger';
import { Functions } from './function';
import { Strings } from './string';

export function createCommandDecorator(registry: Command[]): (command: string, options?: CommandOptions) => Function {
    return (command: string, options?: CommandOptions) => _command(registry, command, options);
}

export interface CommandOptions {
    customErrorHandling?: boolean;
    showErrorMessage?: string;
}

export interface Command {
    name: string;
    key: string;
    method: Function;
    options: CommandOptions;
}

function _command(registry: Command[], command: string, options: CommandOptions = {}): Function {
    return (target: any, key: string, descriptor: any) => {
        if (!(typeof descriptor.value === 'function')) throw new Error('not supported');

        let method;
        if (!options.customErrorHandling) {
            method = async function(this: any, ...args: any[]) {
                try {
                    return await descriptor.value.apply(this, args);
                }
                catch (ex) {
                    Logger.error(ex);

                    if (options.showErrorMessage) {
                        if (Logger.level !== LogLevel.Silent) {
                            const actions: MessageItem[] = [{ title: 'Open Output Channel' }];

                            const result = await window.showErrorMessage(
                                `${options.showErrorMessage} \u00a0\u2014\u00a0 ${ex.toString()}`,
                                ...actions
                            );
                            if (result === actions[0]) {
                                Logger.showOutputChannel();
                            }
                        }
                        else {
                            window.showErrorMessage(`${options.showErrorMessage} \u00a0\u2014\u00a0 ${ex.toString()}`);
                        }
                    }
                }
            };
        }
        else {
            method = descriptor.value;
        }

        registry.push({
            name: `${extensionId}.${command}`,
            key: key,
            method: method,
            options: options
        });
    };
}

function decorate(decorator: (fn: Function, key: string) => Function): Function {
    return (target: any, key: string, descriptor: any) => {
        let fn;
        let fnKey;

        if (typeof descriptor.value === 'function') {
            fn = descriptor.value;
            fnKey = 'value';
        }
        else if (typeof descriptor.get === 'function') {
            fn = descriptor.get;
            fnKey = 'get';
        }

        if (!fn || !fnKey) throw new Error('Not supported');

        descriptor[fnKey] = decorator(fn, key);
    };
}

let correlationCounter = 0;

export interface LogContext<T> {
    prefix: string;
    name: string;
    instance: T;
    instanceName: string;
    id?: number;
}

export const LogInstanceNameFn = Symbol('logInstanceNameFn');

export function logName<T>(fn: (c: T, name: string) => string) {
    return (target: Function) => {
        (target as any)[LogInstanceNameFn] = fn;
    };
}

export function debug<T>(
    options: {
        args?: boolean | { [arg: string]: (arg: any) => string };
        condition?(this: any, ...args: any[]): boolean;
        correlate?: boolean;
        enter?(this: any, ...args: any[]): string;
        exit?(this: any, result: any): string;
        prefix?(this: any, context: LogContext<T>, ...args: any[]): string;
        sanitize?(this: any, key: string, value: any): any;
        timed?: boolean;
    } = { args: true, timed: true }
) {
    return log<T>({ debug: true, ...options });
}

export function log<T>(
    options: {
        args?: boolean | { [arg: string]: (arg: any) => string };
        condition?(this: any, ...args: any[]): boolean;
        correlate?: boolean;
        debug?: boolean;
        enter?(this: any, ...args: any[]): string;
        exit?(this: any, result: any): string;
        prefix?(this: any, context: LogContext<T>, ...args: any[]): string;
        sanitize?(this: any, key: string, value: any): any;
        timed?: boolean;
    } = { args: true, timed: true }
) {
    options = { args: true, timed: true, ...options };

    const logFn = options.debug ? Logger.debug.bind(Logger) : Logger.log.bind(Logger);

    return (target: any, key: string, descriptor: PropertyDescriptor) => {
        if (!(typeof descriptor.value === 'function')) throw new Error('not supported');

        const fn = descriptor.value;

        const isClass = Boolean(target && target.constructor);

        const fnBody = fn.toString().replace(/((\/\/.*$)|(\/\*[\s\S]*?\*\/))/gm, '');
        const parameters: string[] =
            fnBody.slice(fnBody.indexOf('(') + 1, fnBody.indexOf(')')).match(/([^\s,]+)/g) || [];

        descriptor.value = function(this: any, ...args: any[]) {
            if (
                (Logger.level !== LogLevel.Debug && !(Logger.level === LogLevel.Verbose && !options.debug)) ||
                (typeof options.condition === 'function' && !options.condition(...args))
            ) {
                return fn.apply(this, args);
            }

            let instanceName: string;
            if (this != null) {
                instanceName = Logger.toLoggableName(this);
                if (this.constructor != null && this.constructor[LogInstanceNameFn]) {
                    instanceName = target.constructor[LogInstanceNameFn](this, instanceName);
                }
            }
            else {
                instanceName = '';
            }

            let correlationId;
            let prefix: string;
            if (options.correlate || options.timed) {
                correlationId = correlationCounter++;
                prefix = `[${correlationId.toString(16)}] ${instanceName ? `${instanceName}.` : ''}${key}`;
            }
            else {
                prefix = `${instanceName ? `${instanceName}.` : ''}${key}`;
            }

            if (options.prefix != null) {
                prefix = options.prefix(
                    {
                        prefix: prefix,
                        instance: this,
                        name: key,
                        instanceName: instanceName,
                        id: correlationId
                    } as LogContext<T>,
                    ...args
                );
            }

            // Get the class fn in order to store the current log context
            (isClass ? target[key] : fn).$log = {
                correlationId: correlationId,
                prefix: prefix
            } as LogCallerContext;

            if (!options.args || args.length === 0) {
                if (options.enter != null) {
                    logFn(prefix, options.enter(...args));
                }
                else {
                    logFn(prefix);
                }
            }
            else {
                let loggableParams = args
                    .map((v: any, index: number) => {
                        const p = parameters[index];

                        let loggable;
                        if (typeof options.args === 'object' && options.args[index]) {
                            loggable = options.args[index](v);
                        }
                        else {
                            if (typeof v === 'object') {
                                try {
                                    loggable = JSON.stringify(v, options.sanitize);
                                }
                                catch {
                                    loggable = `<error>`;
                                }
                            }
                            else {
                                loggable = String(v);
                            }
                        }

                        return p ? `${p}=${loggable}` : loggable;
                    })
                    .join(', ');

                if (options.enter != null) {
                    loggableParams = `${options.enter(...args)} ${loggableParams}`;
                }

                if (options.debug) {
                    Logger.debug(prefix, loggableParams);
                }
                else {
                    Logger.logWithDebugParams(prefix, loggableParams);
                }
            }

            if (options.timed || options.exit != null) {
                const start = options.timed ? process.hrtime() : undefined;
                const result = fn.apply(this, args);

                if (result != null && Functions.isPromise(result)) {
                    const promise = result.then((r: any) => {
                        const timing =
                            start !== undefined ? ` \u2022 ${Strings.getDurationMilliseconds(start)} ms` : '';
                        let exit;
                        try {
                            exit = options.exit != null ? options.exit(r) : '';
                        }
                        catch (ex) {
                            exit = `@log.exit error: ${ex}`;
                        }
                        logFn(prefix, `completed${timing}${exit}`);
                    });

                    if (typeof promise.catch === 'function') {
                        promise.catch((ex: any) => {
                            const timing =
                                start !== undefined ? ` \u2022 ${Strings.getDurationMilliseconds(start)} ms` : '';
                            Logger.error(ex, prefix, `failed${timing}`);
                        });
                    }
                }
                else {
                    const timing = start !== undefined ? ` \u2022 ${Strings.getDurationMilliseconds(start)} ms` : '';
                    let exit;
                    try {
                        exit = options.exit !== undefined ? options.exit(result) : '';
                    }
                    catch (ex) {
                        exit = `@log.exit error: ${ex}`;
                    }
                    logFn(prefix, `completed${timing}${exit}`);
                }
                return result;
            }

            return fn.apply(this, args);
        };
    };
}

export function gate() {
    return (target: any, key: string, descriptor: PropertyDescriptor) => {
        if (!(typeof descriptor.value === 'function')) throw new Error('not supported');

        const gateKey = `$gate$${key}`;
        const fn = descriptor.value;

        descriptor.value = function(this: any, ...args: any[]) {
            if (!this.hasOwnProperty(gateKey)) {
                Object.defineProperty(this, gateKey, {
                    configurable: false,
                    enumerable: false,
                    writable: true,
                    value: undefined
                });
            }

            let promise = this[gateKey];
            if (promise === undefined) {
                const result = fn.apply(this, args);
                if (result == null || !Functions.isPromise(result)) {
                    return result;
                }

                this[gateKey] = promise = result.then((r: any) => {
                    this[gateKey] = undefined;
                    return r;
                });
            }

            return promise;
        };
    };
}

function _memoize(fn: Function, key: string): Function {
    const memoizeKey = `$memoize$${key}`;

    return function(this: any, ...args: any[]) {
        if (!this.hasOwnProperty(memoizeKey)) {
            Object.defineProperty(this, memoizeKey, {
                configurable: false,
                enumerable: false,
                writable: false,
                value: fn.apply(this, args)
            });
        }

        return this[memoizeKey];
    };
}

export const memoize = decorate(_memoize);
