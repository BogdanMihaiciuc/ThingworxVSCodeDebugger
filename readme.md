# Thingworx VSCode Debugger

This is a VSCode debug adapter created to allow debugging Typescript Thingworx projects created with [ThingworxVScodeProject](https://github.com/BogdanMihaiciuc/ThingworxVSCodeProject) directly from within Visual Studio Code.

This has been created starting from [Mock Debugger](https://github.com/microsoft/vscode-mock-debug).

## Using Thingworx VSCode Debugger

* Install the **ThingworxVSCodeDebugger** extension in VS Code.
* Open a Typescript Thingworx project and create an appropriate attach configuration
   * A sample configuration can be found at [here](https://github.com/BogdanMihaiciuc/ThingworxVSCodeProject/blob/master/.vscode/launch.json).
* Select the debug environment "Attach to Thingworx" or however the attach configuration is named.
* Press the green 'play' button to start debugging.
* Set a breakpoint and launch any service either:
   * From Thingworx composer
   * From the debug console

You can now 'step through' the service, set and hit breakpoints, and so on.

**🖐 NOTE: Only services compiled from Typescript can be debugged. Regular services created in composer or java extension services will be ignored by the debugger.**

## Build and Run

* Clone the project [https://github.com/BogdanMihaiciuc/ThingworxVSCodeDebugger](https://github.com/BogdanMihaiciuc/ThingworxVSCodeDebugger)
* Open the project folder in VS Code.
* Go to Run & Debug and select the "Extension" configuration
* Press the green 'play' button to build and launch ThingworxVSCodeDebugger in another VS Code window. In that window:
  * Open a Typescript Thingworx project and create a lanuch configuration.
  * Follow the steps detailed above to debug the project
