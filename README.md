# 🚀 Electron Debug MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Chrome DevTools Protocol](https://img.shields.io/badge/CDP-4285F4?style=for-the-badge&logo=google-chrome&logoColor=white)](https://chromedevtools.github.io/devtools-protocol/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-6236FF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTggMThhMSAxIDAgMCAxLTEgMUg3YTEgMSAwIDAgMS0xLTFWNmExIDEgMCAwIDEgMS0xaDEwYTEgMSAwIDAgMSAxIDF2MTJ6Ij48L3BhdGg+PHBhdGggZD0iTTEyIDZ2MTIiPjwvcGF0aD48cGF0aCBkPSJNNiA5aDEyIj48L3BhdGg+PHBhdGggZD0iTTYgMTVoMTIiPjwvcGF0aD48L3N2Zz4=&logoColor=white)](https://modelcontextprotocol.ai/)

A powerful Model Context Protocol (MCP) server for debugging Electron applications with deep Chrome DevTools Protocol integration.

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Installation](#-installation)
- [Usage](#-usage)
- [Resource Endpoints](#-resource-endpoints)
- [Chrome DevTools Protocol Integration](#-chrome-devtools-protocol-integration)
- [Examples](#-examples)
- [Development](#-development)
- [Contributing](#-contributing)
- [License](#-license)

## 🔍 Overview

Electron Debug MCP Server provides a bridge between the Model Context Protocol (MCP) and Electron applications, enabling advanced debugging capabilities through a standardized API. It allows you to start, monitor, debug, and control Electron applications programmatically, with deep integration with Chrome DevTools Protocol for advanced debugging features.

## ✨ Features

### 🔄 Core Functionality

- **Process Management**
  - 🚀 Start Electron applications with debugging enabled
  - 🛑 Stop running Electron processes
  - 📋 List all active Electron processes
  - 📊 Monitor process status and logs

### 🔍 Debugging Capabilities

- **Chrome DevTools Protocol Integration**
  - 🎯 Discover and connect to debugging targets
  - 🧩 Execute CDP commands across domains
  - 📝 Evaluate JavaScript in the context of pages
  - 🔄 Reload pages or entire applications
  - ⏯️ Pause and resume JavaScript execution

### 📡 Resource Access

- **Structured Resource Endpoints**
  - 📊 Overview of all running Electron processes
  - 📝 Detailed debug information for specific processes
  - 📜 Access to process logs
  - 🎯 List of available debugging targets
  - 🔍 Direct CDP access for specific targets

## 📥 Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/electron-mcp-server.git

# Navigate to the project directory
cd electron-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

## 🚀 Usage

### Starting the Server

```bash
npm run start
```

This will start the MCP server using stdio for communication.

### Connecting to the Server

The MCP server uses stdio for communication, so clients need to connect using the Model Context Protocol. You can:

- Use an MCP client library
- Connect directly via stdin/stdout
- Use a tool that supports MCP

## 📡 Resource Endpoints

The server exposes the following resource endpoints:

| Resource | Description |
|----------|-------------|
| `electron://info` | Overview of all running Electron processes |
| `electron://process/{id}` | Detailed debug info for a specific process |
| `electron://logs/{id}` | Access to logs for a specific process |
| `electron://targets` | List of all available debug targets |
| `electron://cdp/{processId}/{targetId}` | CDP access for a specific target |
| `electron://operation/{operation}` | Operations to control Electron apps |

### Available Operations

| Operation | Description |
|-----------|-------------|
| `start` | Start an Electron application |
| `stop` | Stop a running Electron process |
| `list` | List all running Electron processes |
| `reload` | Reload a specific page or application |
| `evaluate` | Execute JavaScript in a page context |
| `pause` | Pause JavaScript execution |
| `resume` | Resume JavaScript execution |

## 🔍 Chrome DevTools Protocol Integration

The server integrates with Chrome DevTools Protocol to provide deep debugging capabilities:

### Listing Available Targets

```
GET electron://targets
```

Returns all available debugging targets across all running Electron processes.

### Inspecting a Specific Target

```
GET electron://cdp/{processId}/{targetId}
```

Provides information about the target and available CDP domains.

### Executing CDP Commands

```
GET electron://cdp/{processId}/{targetId}/{domain}/{command}
```

Examples:
- `electron://cdp/electron-123456/page-1/Page/reload` - Reload the page
- `electron://cdp/electron-123456/page-1/Runtime/evaluate` - Evaluate JavaScript
- `electron://cdp/electron-123456/page-1/Debugger/pause` - Pause execution

## 📝 Examples

### Starting an Electron App

```javascript
// Example request (using an MCP client)
const response = await mcpClient.readResource({
  uri: "electron://operation/start",
  content: JSON.stringify({
    appPath: "C:\\path\\to\\your\\electron\\app",
    debugPort: 9222  // Optional debugging port
  })
});
```

### Getting Debug Information

```javascript
// Get detailed info about a specific app
const processId = "electron-1234567890";
const infoResponse = await mcpClient.readResource({
  uri: `electron://process/${processId}`
});
```

### Executing JavaScript in a Page

```javascript
// Execute JavaScript in a page
const evalResponse = await mcpClient.readResource({
  uri: `electron://cdp/electron-123456/page-1/Runtime/evaluate`,
  content: JSON.stringify({
    expression: "document.title",
    returnByValue: true
  })
});
```

## 🛠️ Development

### Project Structure

```
electron-mcp-server/
├── src/
│   ├── index.ts         # Main server implementation
│   └── types/           # TypeScript type definitions
├── build/               # Compiled JavaScript output
├── package.json         # Project dependencies and scripts
└── tsconfig.json        # TypeScript configuration
```

### Building the Project

```bash
npm run build
```

### Running in Development Mode

```bash
npm run dev
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the ISC License - see the LICENSE file for details.

---

Built with ❤️ using TypeScript, Electron, and Chrome DevTools Protocol.
