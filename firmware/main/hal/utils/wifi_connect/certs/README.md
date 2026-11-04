UCL eduroam trust anchors
========================

Public certificates taken from UCL's current CAT EAP configuration on 2026-11-04:

https://cat.eduroam.org/user/API.php?action=downloadInstaller&lang=en&profile=157&device=eap-config&generatedfor=user&openroaming=0

UCL recommends CAT at:
https://www.ucl.ac.uk/isd/services/get-connected/wifi-wireless-networks/eduroam-wifi-ucl

CAT identity provider 130, profile 157, last changed 2026-10-27 11:57:28.
EAP type 25 (PEAP), inner EAP type 26 (MSCHAPv2), server ID
`eduroam.ucl.ac.uk`, inner identity suffix `ucl.ac.uk`.

The PEM contains all four certificates supplied in this CAT profile (including
intermediate certificates). SHA-256 fingerprints:

- AAA Certificate Services: D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4
- USERTrust RSA Certification Authority: E793C9B02FD8AA13E21C31228ACCB08119643B749C898964B1746D46C3D4CBD2
- Sectigo Public Server Authentication CA OV R36: 6542D176BED50F193C0CE297AE44ECD8A0A86BEC2EDE682769344059B4E78530
- Sectigo Public Server Authentication Root R46: 92F351BF3D54164DFA8DD8F9E1139D3150349786485D2B9EECD00E2971C1E6C5

The firmware restricts authentication to this CA set and the server name above,
and enables certificate date checking. The phone supplies current time when
provisioning. The robot retains that known time for cold boots before networking.
Refresh the profile if UCL changes its authentication service or CA certificates.
