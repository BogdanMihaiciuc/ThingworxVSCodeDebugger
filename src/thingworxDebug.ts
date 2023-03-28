/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * mockDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class MockRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in other clients (IDEs) supporting the Debug Adapter Protocol.
 * 
 * The most important class of the Debug Adapter is the MockDebugSession which implements many DAP requests by talking to the MockRuntime.
 */

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, ContinuedEvent
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Subject } from 'await-notify';
import WebSocket from 'ws';
import * as request from 'request';
import { LogOutputEvent } from 'vscode-debugadapter/lib/logger';
import * as path from 'path';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** if specified, results in a simulated compile error in launch. */
	compileError?: 'default' | 'show' | 'hide';
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	
	/**
	 * The domain name of the thingworx server. This must not contain any protocol
	 * or path.
	 */
	thingworxDomain: string;

	/**
	 * Whether SSL should be used when connecting to the given server.
	 */
	useSSL: boolean;

	/**
	 * An app key to use when connecting to the thingworx server. The app key must be for the administrator user.
	 */
	thingworxAppKey: string;

	/**
	 * The port number of the thingworx server.
	 */
	thingworxPort: number;

}


export class ThingworxDebugSession extends LoggingDebugSession {

	/**
	 * The websocket used to recieve messages from the thingworx server.
	 */
	private _websocket?: WebSocket;

	/**
	 * The thingworx appkey to use for authentication.
	 */
	private appKey?: string;

	/**
	 * The thingworx server domain.
	 */
	private domain?: string;

	/**
	 * The thingworx server port.
	 */
	private port?: string;

	/**
	 * Whether the thingworx server uses SSL.
	 */
	private useSSL?: boolean;

	private _configurationDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	/**
	 * Creates a new debug adapter that is used to attach to thingworx.
	 */
	public constructor() {
		super();
	}

	/**
	 * Invokes the given Thingworx debugger service.
	 * @param name 		The name of the service to invoke.
	 * @param args		An optional object containing the arguments to send.
	 */
	private async invokeService(name: string, args: {[key: string]: any} = {}): Promise<any> {
		const url = `${this.useSSL ? 'https' : 'http'}://${this.domain}:${this.port}/Thingworx/Things/BMDebugServer/Services/${name}`;

		return await new Promise((resolve, reject) => {
			request.post({
				url,
				headers: {
					'X-XSRF-TOKEN': 'TWX-XSRF-TOKEN-VALUE',
					'Accept': 'application/json',
					'Content-Type': 'application/json',
					'AppKey': this.appKey,
					'X-THINGWORX-SESSION': 'true',
				},
				body: JSON.stringify(args)
			},
			(err, response, body) => {
				if (err) {
					return reject(err);
				}

				if (response.statusCode != 200) {
					return reject(new Error(`Server returned status code ${response.statusCode}`));
				}

				try {
					return resolve(JSON.parse(body));
				}
				catch (e) {
					return reject(e);
				}
			});
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
		}
		if (args.supportsInvalidatedEvent) {
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = false;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = false;

		// the adapter defines two exceptions filters, one with support for conditions.
		response.body.supportsExceptionFilterOptions = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'exceptions',
				label: "All Exceptions",
				description: `Break when errors are thrown or when a function exits as a result of an error being thrown.`,
				default: false,
				supportsCondition: false,
				conditionDescription: `Enter the exception's name`
			},
			{
				filter: 'caughtExceptions',
				label: "Caught Exceptions",
				description: `Break when errors are thrown or when a function exits as a result of an error being thrown and that error is caught.`,
				default: false,
				supportsCondition: false,
				conditionDescription: `Enter the exception's name`
			},
			{
				filter: 'uncaughtExceptions',
				label: "Uncaught Exceptions",
				description: `Break when errors are thrown or when a function exits as a result of an error being thrown and that error is not caught.`,
				default: false,
				supportsCondition: false,
				conditionDescription: `Enter the exception's name`
			},
		];

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = true;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = false;
		response.body.supportsSteppingGranularity = false;
		response.body.supportsInstructionBreakpoints = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request: DebugProtocol.AttachRequest) {
		// Save the connection details for use when performing requests
		this.domain = args.thingworxDomain;
		this.port = args.thingworxPort.toFixed();
		this.useSSL = args.useSSL;
		this.appKey = args.thingworxAppKey;

		// Attempt to connect to the debug websocket
		const protocol = args.useSSL ? 'wss' : 'ws';

		const websocket = new WebSocket(`${protocol}://${args.thingworxDomain}:${args.thingworxPort | 0}/Thingworx/ThingworxDebugger`);
		this._websocket = websocket;

		websocket.onmessage = async e => {
			// Upon recieving a success message, mark the attach request as successful
			try {
				const socketResponse = JSON.parse(e.data as string);
				if (socketResponse.authenticated) {
					try {
						// Inform the debug server that a debugger connected
						this.invokeService('connectDebugger');
						this.sendResponse(response);
					}
					catch (e) {
						this._websocket?.close();
						this.sendErrorResponse(response, {
							id: 0,
							format: 'Unable to process request',
							showUser: true
						});
					}
				}

				// Set up a different message listener that will deal with events from the server
				websocket.onmessage = e => this._didRecieveMessageWithEvent(e);
				websocket.onerror = e => void 0;
			}
			catch (e) {
				// If unexpected data is sent, disconnect and mark the attach request as failed
				websocket.close();
				this._websocket = undefined;
				this.sendErrorResponse(response, {
					id: 0,
					format: 'Unable to process request',
					showUser: true
				});
			}
		};

		websocket.onopen = e => {
			// Upon opening, authenticate using the app key
			websocket.send(JSON.stringify({appKey: args.thingworxAppKey}));
		};

		websocket.onerror = e => {
			// If unable to connect, send the error response and stop
			this.sendErrorResponse(response, {id: 0, format: e.message, showUser: true});
		}
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		try {
			// Inform the debug server that a debugger disconnected
			this.invokeService('disconnectDebugger');
			this._websocket?.close();
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to disconnect', showUser: true});
		}
	}

	/**
	 * Invoked when a message is sent by the thingworx server.
	 * @param event 	The message event.
	 */
	private _didRecieveMessageWithEvent(event: WebSocket.MessageEvent): void {
		let message;
		try {
			message = JSON.parse(event.data as string);
		}
		catch (e) {
			// Ignore messages that can't be parsed
		}

		switch (message.name) {
			case 'suspended':
				// Currently only suspended messages are sent
				this.sendEvent(new StoppedEvent(message.reason, message.threadID, message.exception));
				break;
			case 'resumed':
				this.sendEvent(new ContinuedEvent(message.threadID, false));
				break;
			case 'log':
				this.sendEvent(new LogOutputEvent(message.body + '\n', message.level));
				break;
			default:
				// Ignore unsupported messages (e.g. sent from future versions of the extension)
		}
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		this.sendErrorResponse(response, {id: 0, format: 'Launch request not supported', showUser: true});

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		try {
			// On windows, typescript reports paths using an uppercase drive letter, but the debugger reports them using
			// a lowercase letter, which causes the debug server to not match any breakpoint locations
			// Additionally, the debug entities use unix path delimiters, while the debugger uses windows delimiters
			let path = args.source.path!;
			if (process.platform == 'win32') {
				path = path[0].toUpperCase() + path.substring(1).replace(/\\/g, '/');
			}

			const result = await this.invokeService('setBreakpointsForFile', {path, breakpoints: {breakpoints: args.breakpoints || []}});
			response.body = response.body || { breakpoints: [] };
			response.body.breakpoints = response.body.breakpoints || [];

			for (const row of result.rows) {
				response.body.breakpoints.push({
					verified: row.verified,
					column: row.column,
					endColumn: row.endColumn,
					endLine: row.endLine,
					id: row.sequenceID,
					line: row.line,
					message: row.message,
					source: args.source
				});
			}

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process request', showUser: true});
		}
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): Promise<void> {
		if (args.source.path) {
			try {
				// On windows, typescript reports paths using an uppercase drive letter, but the debugger reports them using
				// a lowercase letter, which causes the debug server to not match any breakpoint locations
				// Additionally, the debug entities use unix path delimiters, while the debugger uses windows delimiters
				let path = args.source.path!;
				if (process.platform == 'win32') {
					path = path[0].toUpperCase() + path.substring(1).replace(/\\/g, '/');
				}

				console.log(`Getting breakpoints at path ${path}`);

				const locations = await this.invokeService('getBreakpointLocationsInFile', {path, line: args.line, column: args.column, endLine: args.endLine, endColumn: args.endColumn});

				response.body = response.body || {};
				response.body.breakpoints = response.body.breakpoints || [];

				for (const location of locations.rows) {
					response.body.breakpoints.push({
						line: location.line,
						column: location.column,
						endLine: location.endLine,
						endColumn: location.endColumn
					});
				}

				this.sendResponse(response);
			}
			catch(e) {
				this.sendErrorResponse(response, {
					id: 0,
					format: 'Unable to process request',
					showUser: true
				});
			}
		} 
		else {
			response.body = {
				breakpoints: []
			};

			this.sendResponse(response);
		}
	}

	protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
		let exceptions = false;
		let caughtExceptions = false;
		let uncaughtExceptions = false;

		if (args.filterOptions) {
			for (const filterOption of args.filterOptions) {
				switch (filterOption.filterId) {
					case 'exceptions':
						exceptions = true;
						break;
					case 'caughtExceptions':
						caughtExceptions = true;
						break;
					case 'uncaughtExceptions':
						uncaughtExceptions = true;
						break;
				}
			}
		}

		try {
			await this.invokeService('setBreakOnExceptions', {breaks: exceptions, caughtExceptions, uncaughtExceptions});
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {
				id: 0,
				format: 'Unable to process request',
				showUser: true
			});
		}

	}

	protected async exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		try {
			const details = await this.invokeService('getExceptionDetails', {threadID: args.threadId});

			response.body = details;
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process exception info request', showUser: true});
		}
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		try {
			const threads = await this.invokeService('getThreads');

			response.body = response.body || {};
			response.body.threads = response.body.threads || [];

			for (const thread of threads.rows) {
				response.body.threads.push(new Thread(thread.ID, `Thread ${thread.ID.toFixed()}`));
			}

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {
				id: 0,
				format: 'Unable to process request',
				showUser: true
			});
		}
	}

	/**
	 * Contains the mapping between stack frame IDs and their thread IDs.
	 */
	private _scopeThreadMapping: {[key: string]: number} = {};

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		try {
			const frames = await this.invokeService('getStackTraceInThread', {threadID: args.threadId});

			response.body = response.body || {};
			response.body.stackFrames = response.body.stackFrames || [];

			for (const row of frames.rows) {
				const filename = path.normalize(row.source);
				const filenameComponents = filename.split(path.sep);
				response.body.stackFrames.push(new StackFrame(
					row.id,
					row.name,
					new Source(filenameComponents[filenameComponents.length - 1], filename),
					row.line,
					row.column
				));

				this._scopeThreadMapping[row.id] = args.threadId;
			}

			response.body.totalFrames = frames.rows.length;
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process stack trace request', showUser: true});
		}
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {

		try {
			const scopes = await this.invokeService('getScopesInThread', {threadID: this._scopeThreadMapping[args.frameId], frameID: args.frameId});

			response.body = response.body || {};
			response.body.scopes = response.body.scopes || [];

			for (const scopeRow of scopes.rows) {
				const scope = new Scope(scopeRow.name, scopeRow.variablesReference, false);
				response.body.scopes.push(scope);
			}

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process scopes request.', showUser: true});
		}
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		try {
			const variables = await this.invokeService('getVariableContents', {reference: args.variablesReference, filter: args.filter, start: args.start, count: args.count});

			response.body = response.body || {};
			response.body.variables = response.body.variables || [];

			for (const variable of variables.rows) {
				response.body.variables.push(variable);
			}

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process variables request', showUser: true});
		}
	}

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		try {
			const result = await this.invokeService('setVariable', {reference: args.variablesReference, name: args.name, value: args.value});

			response.body = response.body || {};
			response.body.value = result.rows[0].value;
			response.body.variablesReference = result.rows[0].variablesReference;
			response.body.type = result.rows[0].type;
			response.body.indexedVariables = result.rows[0].indexedVariables;
			response.body.namedVariables = result.rows[0].namedVariables;

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process set variable request', showUser: true});
		}
	}

	protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): Promise<void> {
		try {
			await this.invokeService('suspendThread', {threadID: args.threadId});
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process pause request.', showUser: true});
		}
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		try {
			if (args.singleThread) {
				await this.invokeService('resumeThread', {threadID: args.threadId});
				response.body = {allThreadsContinued: false};
			}
			else {
				await this.invokeService('resumeAllThreads');
				response.body = {allThreadsContinued: true};
			}
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process continue request', showUser: true});
		}
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
 	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		try {
			if (args.singleThread) {
				await this.invokeService('stepOverThread', {threadID: args.threadId});
			}
			else {
				await this.invokeService('stepOverThread', {threadID: args.threadId});
			}
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process step over request', showUser: true});
		}
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		try {
			if (args.singleThread) {
				await this.invokeService('stepInThread', {threadID: args.threadId});
			}
			else {
				await this.invokeService('stepInThread', {threadID: args.threadId});
			}
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process step in request', showUser: true});
		}
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
		try {
			if (args.singleThread) {
				await this.invokeService('stepOutThread', {threadID: args.threadId});
			}
			else {
				await this.invokeService('stepOutThread', {threadID: args.threadId});
			}
			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process step in request', showUser: true});
		}
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		let serviceName = 'evaluate';
		if (!('frameId' in args)) {
			// When frame id is missing, use the evaluateGlobally service
			serviceName = 'evaluateGlobally';
		}

		try {
			const result = await this.invokeService(serviceName, {
				expression: args.expression, 
				threadID: this._scopeThreadMapping[args.frameId as any], 
				frameID: args.frameId
			});
			const row = result.rows[0];

			response.body = response.body || {};

			response.body.result = row.value;
			response.body.type = row.type;
			response.body.variablesReference = row.variablesReference;
			response.body.presentationHint = row.presentationHint;
			response.body.indexedVariables = row.indexedVariables;
			response.body.namedVariables = row.namedVariables;

			this.sendResponse(response);
		}
		catch (e) {
			this.sendErrorResponse(response, {id: 0, format: 'Unable to process evaluate request', showUser: true});
		}
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		response.body = {
			targets: [
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			
		}
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		this.sendErrorResponse(response, {id: 0, format: "Unsupported operation", showUser: true});
	}
}

