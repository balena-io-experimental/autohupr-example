import type { OptionalNavigationResource } from 'balena-sdk';
import { getSdk } from 'balena-sdk';
import type { StringValue } from 'ms';
import ms from 'ms';

/** Functional state of HUP on device for our purposes. */
enum HupStatus {
	RUNNING,
	FAILED,
	NOT_RUNNING,
	/** Do not anticipate a device in this state; future proofing. */
	DEVICE_BUSY,
	/** For example, can't determine status if can't reach API. */
	UNKNOWN,
}

const apiKey = (process.env.BALENA_API_KEY as unknown as string) ?? undefined;
const apiUrl = (process.env.BALENA_API_URL as unknown as string) ?? undefined;
const deviceUuid =
	(process.env.BALENA_DEVICE_UUID as unknown as string) ?? undefined;

const checkInterval =
	(process.env.HUP_CHECK_INTERVAL as unknown as StringValue) || '1d';

const userTargetVersion =
	(process.env.HUP_TARGET_VERSION as unknown as string) || '';

if (!apiKey) {
	console.error('BALENA_API_KEY required in environment');
	process.exit(1);
}

if (!apiUrl) {
	console.error('BALENA_API_URL required in environment');
	process.exit(1);
}

if (!deviceUuid) {
	console.error('BALENA_DEVICE_UUID required in environment');
	process.exit(1);
}

const balena = getSdk({
	apiUrl,
	dataDirectory: '/tmp/work',
});

const delay = (value: StringValue) => {
	return new Promise((resolve) => setTimeout(resolve, ms(value)));
};

const getExpandedProp = <T extends object, K extends keyof T>(
	obj: OptionalNavigationResource<T>,
	key: K,
) => (Array.isArray(obj) && obj[0] && obj[0][key]) ?? undefined;

const getDeviceType = async (uuid: string): Promise<string> => {
	return await balena.models.device
		.get(uuid, { $expand: { is_of__device_type: { $select: 'slug' } } })
		.then((device) => {
			return getExpandedProp(device.is_of__device_type, 'slug') as string;
		});
};

const getDeviceVersion = async (uuid: string): Promise<string> => {
	return await balena.models.device.get(uuid).then((device) => {
		return balena.models.device.getOsVersion(device);
	});
};

const getTargetVersion = async (
	deviceType: string,
	deviceVersion: string,
): Promise<string | null> => {
	return await balena.models.os
		.getSupportedOsUpdateVersions(deviceType, deviceVersion)
		.then((osUpdateVersions) => {
			if (userTargetVersion === '') {
				console.log(
					'HUP_TARGET_VERSION must be set to perform automatic updates.',
				);
				return null;
			} else {
				if (['recommended', 'latest'].includes(userTargetVersion)) {
					return osUpdateVersions.recommended!;
				} else {
					return (
						osUpdateVersions.versions.find((version: string) =>
							version.includes(userTargetVersion),
						)! || null
					);
				}
			}
		});
};

/** Retrieve device model for status of HUP properties. */
const getUpdateStatus = async (uuid: string): Promise<HupStatus> => {
	try {
		const hupProps = await balena.models.device.get(uuid, {
			$select: ['status', 'provisioning_state', 'provisioning_progress'],
		});
		console.log(`Device HUP status: ${JSON.stringify(hupProps)}`);

		if (hupProps.status.toLowerCase() === 'configuring') {
			if (hupProps.provisioning_state === 'OS update failed') {
				return HupStatus.FAILED;
			} else {
				return HupStatus.RUNNING;
			}
		} else if (hupProps.status.toLowerCase() === 'idle') {
			return HupStatus.NOT_RUNNING;
		} else {
			return HupStatus.DEVICE_BUSY;
		}
	} catch (e) {
		console.error(`Error getting status: ${e}`);
		return HupStatus.UNKNOWN;
	}
};

const main = async () => {
	const delayStates = [
		HupStatus.UNKNOWN,
		HupStatus.RUNNING,
		HupStatus.DEVICE_BUSY,
	];
	while (true) {
		await balena.auth.loginWithToken(apiKey);

		while (!(await balena.models.device.isOnline(deviceUuid))) {
			console.log('Device is offline...');
			await delay('2m');
		}

		console.log('Checking last update status...');
		while (
			await getUpdateStatus(deviceUuid).then((status) =>
				delayStates.includes(status),
			)
		) {
			console.log('Another update may be in progress...');
			await delay('2m');
		}

		const deviceType = await getDeviceType(deviceUuid);
		const deviceVersion = await getDeviceVersion(deviceUuid);

		console.log(
			`Getting recommended releases for ${deviceType} at ${deviceVersion}...`,
		);

		const targetVersion = await getTargetVersion(deviceType, deviceVersion);

		if (!targetVersion) {
			console.log(`No releases found!`);
		} else {
			console.log(`Starting balenaOS host update to ${targetVersion}...`);
			await balena.models.device
				.startOsUpdate(deviceUuid, targetVersion, { runDetached: true })
				.then(async () => {
					// Allow time for server to start HUP on device, which then
					// sets Configuring status.
					await delay('20s');
					while (
						// Print progress at regular intervals while API indicates
						// HUP still may be running.
						await getUpdateStatus(deviceUuid).then(
							(status) =>
								status === HupStatus.UNKNOWN || status === HupStatus.RUNNING,
						)
					) {
						await delay('20s');
					}
				})
				.catch((e) => {
					console.error(e);
				});
		}

		// both success and failure should wait x before trying/checking again
		console.log(`Will try again in ${checkInterval}...`);
		await delay(checkInterval);
	}
};

console.log('Starting up...');
main().catch((e) => {
	console.error(e);
});
