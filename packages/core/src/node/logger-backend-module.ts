// *****************************************************************************
// Copyright (C) 2017 Ericsson and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { ContainerModule, Container, interfaces } from 'inversify';
import { ConnectionHandler, RpcConnectionHandler } from '../common/messaging';
import { ILogger, LoggerFactory, Logger, setRootLogger, LoggerName } from '../common/logger';
import { ILoggerServer, ILoggerClient, loggerPath, DispatchingLoggerClient } from '../common/logger-protocol';
import { ConsoleLoggerServer } from './console-logger-server';
import { LoggerWatcher } from '../common/logger-watcher';
import { BackendApplicationContribution } from './backend-application';
import { CliContribution } from './cli';
import { LogLevelCliContribution } from './logger-cli-contribution';
import { bindCommonLogger } from '../common/logger-binding';

export function bindLogger(bind: interfaces.Bind, props?: {
    onLoggerServerActivation?: (context: interfaces.Context, server: ILoggerServer) => void
}): void {
    bindCommonLogger(bind);
    bind<ILoggerServer>(ILoggerServer).to(ConsoleLoggerServer).inSingletonScope().onActivation((context, server) => {
        if (props && props.onLoggerServerActivation) {
            props.onLoggerServerActivation(context, server);
        }
        return server;
    });
    bind(LogLevelCliContribution).toSelf().inSingletonScope();
    bind(CliContribution).toService(LogLevelCliContribution);
    bind(LoggerFactory).toFactory(ctx =>
        (name: string) => {
            const child = new Container({ defaultScope: 'Singleton' });
            child.parent = ctx.container;
            child.bind(ILogger).to(Logger).inTransientScope();
            child.bind(LoggerName).toConstantValue(name);
            return child.get(ILogger);
        }
    );
}

/**
 * IMPORTANT: don't use in tests, since it overrides console
 */
export const loggerBackendModule = new ContainerModule(bind => {
    bind(BackendApplicationContribution).toDynamicValue(ctx =>
    ({
        initialize(): void {
            setRootLogger(ctx.container.get<ILogger>(ILogger));
        }
    }));

    bind(DispatchingLoggerClient).toSelf().inSingletonScope();
    bindLogger(bind, {
        onLoggerServerActivation: ({ container }, server) => {
            const dispatchingLoggerClient = container.get(DispatchingLoggerClient);
            server.setClient(dispatchingLoggerClient);

            // register backend logger watcher as a client
            const loggerWatcher = container.get(LoggerWatcher);
            dispatchingLoggerClient.clients.add(loggerWatcher.getLoggerClient());

            // make sure dispatching logger client is the only client
            server.setClient = () => {
                throw new Error('use DispatchingLoggerClient');
            };
        }
    });

    bind(ConnectionHandler).toDynamicValue(({ container }) =>
        new RpcConnectionHandler<ILoggerClient>(loggerPath, client => {
            const dispatching = container.get(DispatchingLoggerClient);
            dispatching.clients.add(client);
            client.onDidCloseConnection(() => dispatching.clients.delete(client));
            return container.get<ILoggerServer>(ILoggerServer);
        })
    ).inSingletonScope();
});
