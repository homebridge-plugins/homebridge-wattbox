# Copilot Instructions for homebridge-wattbox

## Project Overview

This is a Homebridge plugin for WattBox smart outlet controllers. The plugin allows WattBox devices to be integrated with Apple HomeKit through Homebridge, enabling users to control outlets remotely through the Home app.

**Supported Models:**
- WB-300
- WB-300VB  
- WB-700
- WB-700CH

## Architecture

This is a **Dynamic Platform Plugin** for Homebridge that follows the standard Homebridge plugin architecture:

### Key Components

- **`src/index.ts`** - Main entry point that registers the platform with Homebridge
- **`src/platform.ts`** - Core platform implementation (`WattBoxHomebridgePlatform` class)
- **`src/platformAccessory.ts`** - Individual outlet accessory implementation (`WattBoxOutletPlatformAccessory`)
- **`src/wattbox.ts`** - WattBox device API client and communication layer
- **`src/settings.ts`** - Plugin constants, settings, and configuration schemas

### Plugin Flow

1. Platform discovers WattBox device via HTTP API
2. Platform creates individual outlet accessories for each outlet
3. Each outlet appears as a separate switch in HomeKit
4. Status polling keeps HomeKit state synchronized with device state
5. User commands from HomeKit are sent to the WattBox device via HTTP API

## Development Setup

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run linting and formatting
npm run lint
npm run lint-fix

# Link for local development
npm link
npm run watch  # Builds and watches for changes with nodemon
```

## Code Standards

### TypeScript Configuration
- Target: ES2023
- Strict mode enabled
- CommonJS modules
- Source maps and declarations generated

### Linting & Formatting
- **ESLint**: Configured with TypeScript rules, max 0 warnings
- **Prettier**: Used for code formatting
- Run `npm run lint` before committing
- Use `npm run lint-fix` to auto-fix issues

### Testing
- Tests use the same linting rules as source code
- Run `npm test` (currently runs ESLint)
- Test files follow `*.test.ts` naming convention

## Key Dependencies

### Runtime Dependencies
- **homebridge**: Core Homebridge APIs (>= 1.8.5)
- **xml2js**: XML parsing for WattBox API responses
- **cache-manager** & **cacheable**: Status caching to reduce API calls
- **async-lock**: Thread-safe operations
- **pubsub-js**: Event publishing/subscribing

### Development Dependencies
- **typescript**: TypeScript compiler (< 5.6.0)
- **@typescript-eslint**: TypeScript ESLint rules
- **nodemon**: Development auto-reloading
- **jest**: Testing framework (configured but not extensively used)

## Configuration Schema

The plugin accepts configuration through Homebridge's config.json:

### Required Fields
- `platform`: Must be "WattBox"
- `name`: Display name for the platform
- `address`: WattBox device HTTP address (e.g., "http://192.168.1.100")
- `username` & `password`: WattBox device credentials

### Optional Fields
- `includeOutlets`: Array of outlet names to include (whitelist)
- `excludeOutlets`: Array of outlet names to exclude (blacklist)
- `outletStatusCacheTtl`: Cache TTL in seconds (default: 15)
- `outletStatusPollInterval`: Polling interval in milliseconds (default: 15000)

## API Communication

The WattBox devices use HTTP-based APIs:
- Status queries return XML responses that are parsed with xml2js
- Commands are sent via HTTP requests to specific endpoints
- The plugin implements caching and polling to minimize API calls
- Error handling includes retry logic and graceful degradation

## Common Patterns

### Homebridge Platform Plugin Pattern
- Implements `DynamicPlatformPlugin` interface
- Uses `configureAccessory()` for accessory restoration
- Creates accessories dynamically based on device discovery
- Manages accessory lifecycle (add/update/remove)

### Outlet Accessory Pattern
- Each outlet is a separate `PlatformAccessory`
- Uses HomeKit Switch service
- Implements characteristic event handlers for get/set operations
- Maintains local state synchronized with device state

### Error Handling
- Graceful degradation when device is unreachable
- Logging at appropriate levels (error, warn, info, debug)
- User-friendly error messages in Homebridge logs

## Development Guidelines

1. **Follow Homebridge Patterns**: This plugin should follow established Homebridge plugin conventions
2. **Minimize API Calls**: Use caching and efficient polling to avoid overwhelming the WattBox device
3. **Handle Network Issues**: WattBox devices may become temporarily unreachable
4. **Maintain Backwards Compatibility**: Changes should not break existing user configurations
5. **Test with Real Hardware**: WattBox devices have specific quirks that simulators can't replicate

## Common Issues

- **Device Discovery**: Some WattBox models may respond differently to API calls
- **Authentication**: Credential handling varies across models
- **Network Timeouts**: WattBox devices can be slow to respond
- **XML Parsing**: Response formats may vary between firmware versions

## File Organization

- Keep all source code in `src/`
- Main logic should be in platform.ts and platformAccessory.ts
- Device-specific API code belongs in wattbox.ts
- Configuration schemas and constants go in settings.ts
- Follow existing naming conventions for consistency